"""Flask application — general-purpose image viewing, preprocessing & saving tool.

Start:   python app.py
Open:    http://127.0.0.1:5000
"""

from __future__ import annotations

import base64
import io
import json
import os
import time

from flask import Flask, jsonify, render_template, request

import config
import fusion_engine
import image_loader

app = Flask(__name__)

_cache = image_loader.ImageCache(max_size=config.CACHE_SIZE)
os.makedirs(config.OUTPUT_DIR, exist_ok=True)
os.makedirs(config.PRESETS_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _array_to_base64_png(arr) -> str:
    from PIL import Image as PILImage
    img = PILImage.fromarray(arr)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _base64_to_array(uri: str):
    """Decode a data:image/png;base64,... URI into a uint8 numpy array."""
    _, b64 = uri.split(",", 1)
    from PIL import Image as PILImage
    buf = io.BytesIO(base64.b64decode(b64))
    return np.array(PILImage.open(buf))


import numpy as np


def _usm_sharp(img: np.ndarray, weight=0.5, radius=50, threshold=10) -> np.ndarray:
    """USM sharpening. img: uint8 (H,W) grayscale or (H,W,3) RGB."""
    import cv2
    if radius % 2 == 0:
        radius += 1
    f = img.astype(np.float32) / 255.0
    blur = cv2.GaussianBlur(f, (radius, radius), 0)
    residual = f - blur
    mask = (np.abs(residual) * 255 > threshold).astype(np.float32)
    soft_mask = cv2.GaussianBlur(mask, (radius, radius), 0)
    sharp = np.clip(f + weight * residual, 0, 1)
    out = soft_mask * sharp + (1 - soft_mask) * f
    return np.clip(out * 255, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# Algorithm specs — single source of truth for the frontend
# ---------------------------------------------------------------------------

ALGORITHMS = {
    # ---- 单图算法 ----
    "usm_sharp": {
        "group": "单图算法", "label": "USM 锐化", "n_images": 1,
        "specs": [
            {"id": "weight", "label": "锐化强度", "min": 0.0, "max": 3.0, "step": 0.01, "default": 0.5},
            {"id": "radius", "label": "模糊半径", "min": 1, "max": 99, "step": 1, "default": 50},
            {"id": "threshold", "label": "边缘阈值", "min": 0, "max": 50, "step": 1, "default": 10},
        ],
        "info": {
            "about": (
                "<p><b>非锐化掩模 (Unsharp Masking)</b>，最经典的图像锐化技术，源自暗房工艺。"
                "从原图中减去高斯模糊版得到\"细节残差\"，加权加回原图。"
                "threshold 掩码确保只在显著边缘处锐化，避免平坦区噪声被放大。</p>"
                "<p><b>公式：</b> sharp = I + w × (I − G_σ(I))，由 soft_mask 仅在边缘区域激活。</p>"
                "<p><b>适用：</b>超分后处理、纹理增强、模糊恢复。</p>"
            ),
            "params": {
                "weight": (
                    "<b>概念：</b>细节残差的放大倍数。weight=0 不锐化，weight=1 标准强度。<br>"
                    "<b>作用：</b>控制锐化效果的强弱。值越大边缘越锐利，但过高会产生 halo（光晕）伪影。<br>"
                    "<b>调节：</b>从 0.5 开始。图像模糊严重可增至 1.0~1.5。出现白边/黑边时降低。"
                ),
                "radius": (
                    "<b>概念：</b>高斯模糊核的半径（像素），决定\"细节残差\"的空间尺度。<br>"
                    "<b>作用：</b>小半径增强细纹理（毛发、噪点），大半径增强粗轮廓（物体边缘）。<br>"
                    "<b>调节：</b>默认 50 适合中等纹理。细纹理增强用 10~30，大尺度轮廓用 70~99。"
                ),
                "threshold": (
                    "<b>概念：</b>最小边缘强度阈值。|残差|×255 低于此值的像素不参与锐化。<br>"
                    "<b>作用：</b>过滤噪声——只有真正边缘处才锐化，平坦区域保持不变。<br>"
                    "<b>调节：</b>默认 10。噪声多的图像提高到 15~20；纹理丰富的干净图像可降到 3~5。"
                ),
            },
        },
    },
    "clahe": {
        "group": "单图算法", "label": "CLAHE 自适应直方图均衡", "n_images": 1,
        "specs": [
            {"id": "clip_limit", "label": "对比度限制", "min": 1.0, "max": 10.0, "step": 0.1, "default": 2.0},
            {"id": "tile_size", "label": "分块大小", "min": 4, "max": 64, "step": 1, "default": 8},
        ],
        "info": {
            "about": (
                "<p><b>Contrast Limited Adaptive Histogram Equalization</b>。"
                "将图像分成小块，每块独立做直方图均衡，裁剪直方图峰值限制对比度放大，"
                "块间双线性插值消除边界伪影。相比全局直方图均衡，CLAHE 能保留局部细节。</p>"
                "<p><b>适用：</b>红外低对比度增强、曝光不足校正、雾天图像增强。</p>"
            ),
            "params": {
                "clip_limit": (
                    "<b>概念：</b>直方图裁剪阈值。限制每个灰度级的最大累积概率。<br>"
                    "<b>作用：</b>值越小对比度增强越保守（越接近原图），值越大增强越激进但噪声也被放大。<br>"
                    "<b>调节：</b>默认 2.0。低对比度 IR 图像可增至 3~5；噪声多的图保持 1~2。"
                ),
                "tile_size": (
                    "<b>概念：</b>分块尺寸（像素）。图像被划分为 tile_size × tile_size 的网格块。<br>"
                    "<b>作用：</b>小块 = 强局部性，每个区域独立均衡；大块 = 接近全局均衡，局部细节弱。<br>"
                    "<b>调节：</b>默认 8。细节丰富的图用 4~8；大面积均匀区域用 16~32。"
                ),
            },
        },
    },
    "bilateral": {
        "group": "单图算法", "label": "双边滤波 (保边去噪)", "n_images": 1,
        "specs": [
            {"id": "d", "label": "滤波直径", "min": 3, "max": 25, "step": 1, "default": 9},
            {"id": "sigma_color", "label": "颜色 σ", "min": 5, "max": 200, "step": 1, "default": 75},
            {"id": "sigma_space", "label": "空间 σ", "min": 5, "max": 200, "step": 1, "default": 75},
        ],
        "info": {
            "about": (
                "<p><b>保边平滑滤波器</b>。普通高斯模糊只看像素距离，边缘两侧会相互污染。"
                "双边滤波同时考虑空间距离和像素值差异：颜色差异大的像素即使距离近权重也低，边缘得以保留。</p>"
                "<p><b>公式：</b> BF[I]_p = (1/W_p) Σ G_σs(‖p−q‖) · G_σr(|I_p−I_q|) · I_q</p>"
                "<p><b>适用：</b>红外去噪保留热源边缘、纹理预处理、美颜磨皮。</p>"
            ),
            "params": {
                "d": (
                    "<b>概念：</b>滤波器的直径（像素）。决定每个像素的邻域范围。<br>"
                    "<b>作用：</b>直径越大平滑越强，但计算量增大。d≤0 时由 sigma_space 自动确定。<br>"
                    "<b>调节：</b>默认 9。强噪声用 15~25，轻度平滑用 5~7。"
                ),
                "sigma_color": (
                    "<b>概念：</b>像素值（颜色）差异的高斯标准差。控制\"多大颜色差异算边缘\"。<br>"
                    "<b>作用：</b>值越大，颜色差异大的像素也能互相影响 → 平滑更强但边缘保持减弱。<br>"
                    "<b>调节：</b>默认 75。强去噪增至 100~150；精细保边降至 30~50。"
                ),
                "sigma_space": (
                    "<b>概念：</b>空间距离的高斯标准差。控制\"多远距离开始权重衰减\"。<br>"
                    "<b>作用：</b>值越大，更远的像素参与平滑 → 整体更模糊。值小则只有紧邻像素参与。<br>"
                    "<b>调节：</b>默认 75。与 sigma_color 配合：去噪为主时两者都大，保边为主时 sigma_color 大 sigma_space 小。"
                ),
            },
        },
    },
    "gamma": {
        "group": "单图算法", "label": "Gamma 校正", "n_images": 1,
        "specs": [
            {"id": "gamma", "label": "Gamma 值", "min": 0.1, "max": 5.0, "step": 0.01, "default": 1.0},
        ],
        "info": {
            "about": (
                "<p><b>幂律变换 (Power-Law Transform)</b>，非线性亮度映射。</p>"
                "<p><b>公式：</b> out = in^γ × 255</p>"
                "<p><b>适用：</b>暗区细节增强（γ<1）、过曝恢复（γ>1）。</p>"
            ),
            "params": {
                "gamma": (
                    "<b>概念：</b>幂函数的指数。γ=1 为恒等变换，不改变图像。<br>"
                    "<b>作用：</b>γ < 1 拉伸暗区、压缩亮区——暗部变亮（提亮阴影）。"
                    "γ > 1 压缩暗区、拉伸亮区——亮部细节更清晰（压暗高光）。<br>"
                    "<b>调节：</b>暗 IR 图像用 0.5~0.8；过曝图像用 1.5~2.5。先调 γ 再调亮度/对比度。"
                ),
            },
        },
    },
    "brightness_contrast": {
        "group": "单图算法", "label": "亮度/对比度", "n_images": 1,
        "specs": [
            {"id": "alpha", "label": "对比度 (α)", "min": 0.1, "max": 3.0, "step": 0.01, "default": 1.0},
            {"id": "beta", "label": "亮度 (β)", "min": -100, "max": 100, "step": 1, "default": 0},
        ],
        "info": {
            "about": (
                "<p><b>线性变换</b>，最基本的图像调整。out = α × in + β。</p>"
                "<p><b>适用：</b>快速调图、曝光补偿、批量归一化。</p>"
            ),
            "params": {
                "alpha": (
                    "<b>概念：</b>斜率，控制输出值对输入值的放大倍数。<br>"
                    "<b>作用：</b>α>1 增强对比度（亮的更亮、暗的更暗），α<1 降低对比度（趋于灰色）。<br>"
                    "<b>调节：</b>默认 1.0。低对比度图增至 1.3~1.8；高对比度图降至 0.6~0.9。"
                ),
                "beta": (
                    "<b>概念：</b>截距，整体亮度偏移量（单位：灰度级 0-255）。<br>"
                    "<b>作用：</b>正值整体提亮，负值整体压暗。不影响对比度。<br>"
                    "<b>调节：</b>默认 0。暗图 +20~+50，亮图 -20~-50。通常先调 α 再调 β。"
                ),
            },
        },
    },
    "gaussian_blur": {
        "group": "单图算法", "label": "高斯模糊", "n_images": 1,
        "specs": [
            {"id": "kernel_size", "label": "核大小", "min": 3, "max": 51, "step": 2, "default": 5},
            {"id": "sigma", "label": "Sigma", "min": 0.1, "max": 20.0, "step": 0.1, "default": 1.0},
        ],
        "info": {
            "about": (
                "<p><b>高斯平滑滤波器</b>，最常用的线性低通滤波。"
                "用高斯函数 G(x,y)=exp(−(x²+y²)/2σ²) 作为权重核对图像做卷积。</p>"
                "<p><b>适用：</b>降噪预处理、高频伪影去除、USM 锐化的前置步骤。</p>"
            ),
            "params": {
                "kernel_size": (
                    "<b>概念：</b>卷积核的尺寸（像素）。必须是奇数。<br>"
                    "<b>作用：</b>决定模糊的空间范围。核越大覆盖的邻域越广，模糊越强。<br>"
                    "<b>调节：</b>默认 5。轻度降噪用 3~5（配合小 sigma），强模糊用 15~31。"
                ),
                "sigma": (
                    "<b>概念：</b>高斯函数的标准差，控制权重分布的\"宽度\"。<br>"
                    "<b>作用：</b>sigma 越小，中心像素权重越大 → 模糊弱；sigma 越大，权重越均匀 → 模糊强。<br>"
                    "<b>调节：</b>默认 1.0。轻度平滑用 0.5~1.5，强模糊用 3~10。sigma > kernel_size/3 时核边缘权重不衰减，效果接近均值滤波。"
                ),
            },
        },
    },
    # ---- 多图算法 ----
    "alpha": {
        "group": "多图算法", "label": "Alpha 混合", "n_images": 2,
        "specs": fusion_engine.SLIDER_SPECS["alpha"],
        "info": {
            "about": (
                "<p><b>线性透明度混合</b>。out = α × A + (1−α) × B。</p>"
                "<p><b>适用：</b>两张 SR 输出加权平均、A/B 混合对比。</p>"
            ),
            "params": {
                "alpha": (
                    "<b>概念：</b>图 A 的权重，范围 [0, 1]。<br>"
                    "<b>作用：</b>α=1 只有 A，α=0 只有 B，α=0.5 两者等权平均。<br>"
                    "<b>调节：</b>默认 0.5。偏 A 调大，偏 B 调小。"
                ),
            },
        },
    },
    "weighted": {
        "group": "多图算法", "label": "加权混合", "n_images": -1, "specs": [],
        "info": {
            "about": (
                "<p><b>N 图加权平均</b>。out = Σ w_i × I_i，Σ w_i = 1。</p>"
                "<p><b>适用：</b>多教师融合、多曝光合成、多帧降噪平均。</p>"
            ),
            "params": {},
        },
    },
    "frequency": {
        "group": "多图算法", "label": "频域分离融合", "n_images": 2,
        "specs": fusion_engine.SLIDER_SPECS["frequency"],
        "info": {
            "about": (
                "<p><b>高低频分离融合</b>。用高斯模糊将图像分解为低频（色调/光照）和高频（纹理/细节），分别按不同权重融合。</p>"
                "<p><b>适用：</b>保留 A 的色调 + B 的细节。</p>"
            ),
            "params": {
                "lf_a_weight": (
                    "<b>概念：</b>低频部分中 Teacher A 的权重。<br>"
                    "<b>作用：</b>控制最终图像的色调/亮度偏向哪张图。值大偏 A 的色调，值小偏 B。<br>"
                    "<b>调节：</b>默认 0.7。希望整体色调像 A 时用 0.7~1.0，像 B 时用 0~0.3。"
                ),
                "hf_a_weight": (
                    "<b>概念：</b>高频部分中 Teacher A 的权重。<br>"
                    "<b>作用：</b>控制最终图像的纹理/细节偏向哪张图。值大偏 A 的细节，值小偏 B。<br>"
                    "<b>调节：</b>默认 0.3。希望纹理像 A 时用 0.5~1.0，像 B 时用 0~0.5。与 lf 权重独立调节。"
                ),
                "blur_sigma": (
                    "<b>概念：</b>分离高低频的高斯模糊 σ。<br>"
                    "<b>作用：</b>决定\"多粗的纹理算高频\"。σ 大小 = 只有细纹理算高频；σ 大 = 粗纹理也算高频。<br>"
                    "<b>调节：</b>默认 3.0。细纹理融合用 1~3，粗结构融合用 5~20。"
                ),
            },
        },
    },
    "edge_guided": {
        "group": "多图算法", "label": "边缘引导融合", "n_images": 2,
        "specs": fusion_engine.SLIDER_SPECS["edge_guided"],
        "info": {
            "about": (
                "<p><b>基于边缘强度的自适应融合</b>。用 Sobel 算子检测边缘，边缘区取 A，平坦区取 B，软掩码平滑过渡。</p>"
                "<p><b>适用：</b>A 边缘锐利 + B 平坦区干净——各取所长。</p>"
            ),
            "params": {
                "a_weight_edge": (
                    "<b>概念：</b>边缘区域中 Teacher A 的权重。<br>"
                    "<b>作用：</b>控制边缘处偏向 A 的程度。值大则边缘更锐利但可能带噪声。<br>"
                    "<b>调节：</b>默认 0.8。A 边缘清晰用 0.7~1.0，A 边缘有噪声用 0.5~0.7。"
                ),
                "b_weight_flat": (
                    "<b>概念：</b>平坦区域中 Teacher B 的权重。<br>"
                    "<b>作用：</b>控制平坦区偏向 B 的程度。值大则平坦区更干净。<br>"
                    "<b>调节：</b>默认 0.7。B 平坦干净用 0.7~1.0，想让平坦区也有 A 特征用 0.3~0.5。"
                ),
                "edge_threshold": (
                    "<b>概念：</b>Sobel 边缘强度的判定阈值。<br>"
                    "<b>作用：</b>低于此值的区域视为平坦区，高于的视为边缘区。值越大\"边缘区\"越少。<br>"
                    "<b>调节：</b>默认 2.0。图整体纹理少用 1~2，纹理多用 3~5。"
                ),
            },
        },
    },
    "pyramid": {
        "group": "多图算法", "label": "金字塔融合", "n_images": 2,
        "specs": fusion_engine.SLIDER_SPECS["pyramid"],
        "info": {
            "about": (
                "<p><b>多尺度拉普拉斯金字塔融合</b>。构建 3 层 Laplacian 金字塔，每层独立按权重混合后重建。</p>"
                "<p><b>适用：</b>无缝拼接、HDR 融合、多尺度控制场景。</p>"
            ),
            "params": {
                "lvl0_weight": (
                    "<b>概念：</b>原分辨率层（最细尺度）中 Teacher A 的权重。<br>"
                    "<b>作用：</b>控制最细纹理的融合比例。值大 = A 的细纹理占主导。<br>"
                    "<b>调节：</b>默认 0.8。需要 A 的细纹理用 0.7~1.0，需要 B 用 0~0.3。"
                ),
                "lvl1_weight": (
                    "<b>概念：</b>½ 分辨率层（中等尺度）中 Teacher A 的权重。<br>"
                    "<b>作用：</b>控制中等纹理（如物体内部结构）的融合。<br>"
                    "<b>调节：</b>默认 0.5。中等尺度均衡融合时保持 0.5 附近。"
                ),
                "lvl2_weight": (
                    "<b>概念：</b>¼ 分辨率层（最粗尺度）中 Teacher A 的权重。<br>"
                    "<b>作用：</b>控制大尺度结构（如整体亮度分布）的融合。<br>"
                    "<b>调节：</b>默认 0.2。粗尺度通常偏 B 以保持整体色调自然。"
                ),
            },
        },
    },
}



# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/scan_folder", methods=["POST"])
def api_scan_folder():
    """Scan a directory — return file metadata only, no image loading.

    Request:  {"path": "D:/..."}
    Response: {"files": [{"name": "001.png", "path": "D:/.../001.png"}, ...], "total": 1000}
    """
    data = request.get_json(silent=True) or {}
    path = data.get("path", "").strip()
    if not path or not os.path.isdir(path):
        return jsonify({"status": "error", "message": "Invalid directory path"}), 400

    files = image_loader.list_images(path)
    if not files:
        return jsonify({"status": "error", "message": "No images found"}), 404

    result = [{"name": f, "path": os.path.join(path, f)} for f in files]
    return jsonify({"status": "ok", "path": path, "files": result, "total": len(result)})


@app.route("/api/load_folder", methods=["POST"])
def api_load_folder():
    """Load a specific page of images from a directory (on-demand).

    Request:  {"path": "D:/...", "names": ["001.png","002.png"]}
    Response: {"images": [{"name": "001.png", "uri": "data:..."}, ...]}
    """
    data = request.get_json(silent=True) or {}
    path = data.get("path", "").strip()
    names = data.get("names", [])
    if not path or not os.path.isdir(path) or not names:
        return jsonify({"status": "error", "message": "Invalid request"}), 400

    images = []
    for f in names:
        full = os.path.join(path, f)
        try:
            arr = image_loader._load_image_uint8(full)
            uri = _array_to_base64_png(arr)
            images.append({"name": f, "path": full, "uri": uri})
        except Exception:
            continue

    return jsonify({"status": "ok", "images": images})


def _run_single_algo(img: np.ndarray, algorithm: str, params: dict) -> np.ndarray:
    """Run one single-image algorithm. img: uint8 numpy array."""
    if algorithm == "usm_sharp":
        return _usm_sharp(img,
                          weight=float(params.get("weight", 0.5)),
                          radius=int(params.get("radius", 50)),
                          threshold=int(params.get("threshold", 10)))
    elif algorithm == "clahe":
        import cv2
        img_u8 = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        clahe = cv2.createCLAHE(
            clipLimit=float(params.get("clip_limit", 2.0)),
            tileGridSize=(int(params.get("tile_size", 8)), int(params.get("tile_size", 8))))
        result = clahe.apply(img_u8)
        return result if result.ndim == 3 else np.stack([result, result, result], axis=-1)
    elif algorithm == "bilateral":
        import cv2
        return cv2.bilateralFilter(img,
                                   d=int(params.get("d", 9)),
                                   sigmaColor=float(params.get("sigma_color", 75)),
                                   sigmaSpace=float(params.get("sigma_space", 75)))
    elif algorithm == "gamma":
        f = img.astype(np.float32) / 255.0
        g = float(params.get("gamma", 1.0))
        return np.clip(np.power(f, g) * 255, 0, 255).astype(np.uint8)
    elif algorithm == "brightness_contrast":
        f = img.astype(np.float32)
        alpha = float(params.get("alpha", 1.0))
        beta = float(params.get("beta", 0))
        return np.clip(alpha * f + beta, 0, 255).astype(np.uint8)
    elif algorithm == "gaussian_blur":
        import cv2
        ks = int(params.get("kernel_size", 5))
        if ks % 2 == 0: ks += 1
        return cv2.GaussianBlur(img, (ks, ks), float(params.get("sigma", 1.0)))
    else:
        raise ValueError(f"Unknown single-image algorithm: {algorithm}")


@app.route("/api/process", methods=["POST"])
def api_process():
    """Run algorithm(s) and return the result. Supports both single and pipeline modes.

    Single:  {"images": [...], "algorithm": "usm_sharp", "params": {...}}
    Pipeline: {"images": [...], "pipeline": [{"algorithm": "clahe", "params": {...}}, ...]}
    """
    data = request.get_json(silent=True) or {}
    pipeline = data.get("pipeline", None)
    algorithm = data.get("algorithm", "")
    uris = data.get("images", [])

    # Decode first image
    if not uris:
        return jsonify({"status": "error", "message": "No images provided"}), 400
    try:
        imgs = [_base64_to_array(uri) for uri in uris]
    except Exception:
        return jsonify({"status": "error", "message": "Failed to decode image"}), 400

    t0 = time.perf_counter()

    if pipeline and isinstance(pipeline, list):
        # Pipeline mode: run single-image steps sequentially
        result = imgs[0]
        for step in pipeline:
            a = step.get("algorithm", "")
            p = step.get("params", {})
            if a not in ALGORITHMS or ALGORITHMS[a].get("n_images") != 1:
                return jsonify({"status": "error", "message": f"Invalid pipeline step: {a}"}), 400
            result = _run_single_algo(result, a, p)
    elif algorithm in ALGORITHMS and ALGORITHMS[algorithm].get("n_images") == 1:
        # Single single-image algorithm
        result = _run_single_algo(imgs[0], algorithm, data.get("params", {}))
    else:
        # Multi-image fusion
        if algorithm not in ALGORITHMS:
            return jsonify({"status": "error", "message": f"Unknown algorithm: {algorithm}"}), 400
        n = len(imgs)
        clean = fusion_engine.validate_params(algorithm, data.get("params", {}), n)
        result = fusion_engine.fuse(imgs, algorithm, clean, 0, min(1, n - 1))

    elapsed_ms = (time.perf_counter() - t0) * 1000
    return jsonify({
        "status": "ok",
        "result_uri": _array_to_base64_png(result),
        "time_ms": round(elapsed_ms, 1),
    })


@app.route("/api/batch_process", methods=["POST"])
def api_batch_process():
    """Apply a pipeline to all images in a source folder, save to output folder.

    Request:  {"pipeline": [{"algorithm": "clahe", "params": {...}}, ...],
               "source_dir": "D:/input", "output_dir": "D:/output"}
    Response: {"processed": 95, "failed": 5, "errors": ["file1: ..."], "time_ms": 4200}
    """
    data = request.get_json(silent=True) or {}
    pipeline = data.get("pipeline", [])
    src = data.get("source_dir", "").strip()
    dst = data.get("output_dir", "").strip()

    if not pipeline or not isinstance(pipeline, list):
        return jsonify({"status": "error", "message": "Invalid or empty pipeline"}), 400
    if not src or not os.path.isdir(src):
        return jsonify({"status": "error", "message": "Invalid source directory"}), 400
    if not dst:
        return jsonify({"status": "error", "message": "Output directory required"}), 400

    # Validate pipeline steps
    for step in pipeline:
        a = step.get("algorithm", "")
        if a not in ALGORITHMS or ALGORITHMS[a].get("n_images") != 1:
            return jsonify({"status": "error", "message": f"Invalid pipeline step: {a}"}), 400

    os.makedirs(dst, exist_ok=True)
    files = image_loader.list_images(src)
    if not files:
        return jsonify({"status": "error", "message": "No images found in source"}), 404

    t0 = time.perf_counter()
    processed, failed = 0, 0
    errors = []

    for fname in files:
        fpath = os.path.join(src, fname)
        try:
            arr = image_loader._load_image_uint8(fpath)
            result = arr
            for step in pipeline:
                result = _run_single_algo(result, step["algorithm"], step.get("params", {}))
            # Save with same filename
            out_path = os.path.join(dst, fname)
            from PIL import Image as PILImage
            PILImage.fromarray(result).save(out_path)
            processed += 1
        except Exception as exc:
            failed += 1
            if len(errors) < 10:
                errors.append(f"{fname}: {exc}")

    elapsed_ms = (time.perf_counter() - t0) * 1000
    return jsonify({
        "status": "ok",
        "processed": processed, "failed": failed,
        "errors": errors, "total": len(files),
        "output_dir": dst, "time_ms": round(elapsed_ms, 1),
    })


@app.route("/api/algorithm_specs", methods=["GET"])
def api_algorithm_specs():
    """Return algorithm metadata and slider specs."""
    return jsonify({"status": "ok", "algorithms": ALGORITHMS})


@app.route("/api/save", methods=["POST"])
def api_save():
    """Save an image to output directory.

    Request:
        {"image_data": "data:image/png;base64,...",
         "filename": "my_image.png",
         "batch_name": "my_batch"}
    Output:
        output/<batch_name>/<filename>.png
    """
    data = request.get_json(silent=True) or {}
    image_data_uri = data.get("image_data", "")
    if not image_data_uri:
        return jsonify({"status": "error", "message": "Missing image_data"}), 400

    _, b64 = image_data_uri.split(",", 1)
    img_bytes = base64.b64decode(b64)

    filename = data.get("filename", "saved.png").strip()
    safe_fn = "".join(c for c in filename if c.isalnum() or c in "._- ")
    if not safe_fn or not safe_fn.lower().endswith(".png"):
        safe_fn = (safe_fn or "saved") + ".png"

    batch_name = data.get("batch_name", "").strip()
    if not batch_name:
        from datetime import datetime
        batch_name = "saved_" + datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_batch = "".join(c for c in batch_name if c.isalnum() or c in "_- ") or "default"

    base_dir = data.get("base_dir", "").strip()
    batch_dir = os.path.join(base_dir if base_dir else config.OUTPUT_DIR, safe_batch)
    os.makedirs(batch_dir, exist_ok=True)
    png_path = os.path.join(batch_dir, safe_fn)
    with open(png_path, "wb") as f:
        f.write(img_bytes)

    return jsonify({
        "status": "ok", "path": png_path,
        "batch": safe_batch, "filename": safe_fn,
    })


@app.route("/api/save_crop", methods=["POST"])
def api_save_crop():
    """Save cropped image region to output directory."""
    data = request.get_json(silent=True) or {}
    image_data_uri = data.get("image_data", "")
    if not image_data_uri:
        return jsonify({"status": "error", "message": "Missing image_data"}), 400

    _, b64 = image_data_uri.split(",", 1)
    img_bytes = base64.b64decode(b64)

    filename = data.get("filename", "crop.png").strip()
    if not filename.lower().endswith(".png"):
        filename += ".png"
    safe_filename = "".join(c for c in filename if c.isalnum() or c in "._- ") or "crop.png"

    batch_name = data.get("batch_name", "crops").strip()
    safe_batch = "".join(c for c in batch_name if c.isalnum() or c in "_- ") or "crops"

    batch_dir = os.path.join(config.OUTPUT_DIR, safe_batch)
    os.makedirs(batch_dir, exist_ok=True)
    png_path = os.path.join(batch_dir, safe_filename)
    with open(png_path, "wb") as f:
        f.write(img_bytes)

    return jsonify({
        "status": "ok", "path": png_path,
        "batch": safe_batch, "filename": safe_filename,
    })


@app.route("/api/presets", methods=["GET", "POST"])
def api_presets():
    if request.method == "GET":
        presets = {}
        if os.path.isdir(config.PRESETS_DIR):
            for fname in sorted(os.listdir(config.PRESETS_DIR)):
                if fname.endswith(".json"):
                    fpath = os.path.join(config.PRESETS_DIR, fname)
                    try:
                        with open(fpath, "r", encoding="utf-8") as f:
                            presets[os.path.splitext(fname)[0]] = json.load(f)
                    except (json.JSONDecodeError, OSError):
                        continue
        return jsonify({"status": "ok", "presets": presets})

    # POST
    data = request.get_json(silent=True) or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"status": "error", "message": "Preset name is required"}), 400
    safe_name = "".join(c for c in name if c.isalnum() or c in "_- ")
    if not safe_name:
        return jsonify({"status": "error", "message": "Invalid preset name"}), 400
    fpath = os.path.join(config.PRESETS_DIR, safe_name + ".json")
    # Store all fields except "name"
    preset_data = {k: v for k, v in data.items() if k != "name"}
    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(preset_data, f, indent=2)
    return jsonify({"status": "ok", "name": safe_name})


@app.route("/api/presets/<name>", methods=["DELETE"])
def api_presets_delete(name: str):
    safe_name = "".join(c for c in name if c.isalnum() or c in "_- ")
    fpath = os.path.join(config.PRESETS_DIR, safe_name + ".json")
    if os.path.exists(fpath):
        os.remove(fpath)
        return jsonify({"status": "ok"})
    return jsonify({"status": "error", "message": f"Preset not found: {safe_name}"}), 404


@app.route("/api/browse", methods=["GET"])
def api_browse():
    """Browse local filesystem directories.

    Query: ?path=D:/wuzq/datasets
    """
    import string
    path = request.args.get("path", "").strip()

    if not path:
        drives = []
        for letter in string.ascii_uppercase:
            p = letter + ":\\"
            if os.path.exists(p):
                drives.append({"name": p, "path": p})
        return jsonify({"status": "ok", "path": "", "parent": None, "drives": drives, "dirs": []})

    path = os.path.abspath(path)
    if not os.path.exists(path):
        return jsonify({"status": "error", "message": f"Path not found: {path}"}), 404
    if not os.path.isdir(path):
        return jsonify({"status": "error", "message": "Not a directory"}), 400

    parent = os.path.dirname(path)
    if parent == path:
        parent = None

    try:
        entries = os.listdir(path)
    except PermissionError:
        return jsonify({"status": "error", "message": "Permission denied"}), 403

    subdirs = []
    for name in sorted(entries, key=lambda n: n.lower()):
        full = os.path.join(path, name)
        if os.path.isdir(full) and not name.startswith("."):
            try:
                has_pngs = any(f.lower().endswith((".png", ".bmp", ".jpg", ".jpeg"))
                              for f in os.listdir(full))
            except (PermissionError, OSError):
                has_pngs = False
            subdirs.append({
                "name": name, "path": full,
                "has_pngs": has_pngs,
                "png_count": sum(1 for f in os.listdir(full)
                                 if f.lower().endswith((".png", ".bmp", ".jpg", ".jpeg"))) if has_pngs else 0,
            })

    return jsonify({
        "status": "ok", "path": path,
        "parent": parent, "drives": [], "dirs": subdirs,
    })


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Image Tool")
    parser.add_argument("--port", type=int, default=None, help="Server port (default: 5000)")
    args = parser.parse_args()

    port = args.port if args.port is not None else config.PORT
    print(f"Image Tool v5")
    print(f"  Output dir:  {config.OUTPUT_DIR}")
    print(f"  Presets dir: {config.PRESETS_DIR}")
    print(f"  Listening on http://{config.HOST}:{port}")
    app.run(host=config.HOST, port=port, debug=config.DEBUG)
