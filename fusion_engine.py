"""Fusion algorithms for multi-teacher image blending.

Every pairwise function:  fusion_xxx(img_a, img_b, params) -> uint8 array
N-teacher alpha:         fusion_weighted(images, params) -> uint8 array

- *img_a*, *img_b*, *images[i]* : float32 numpy (H, W, 3), [0, 255].
- *result* : uint8 numpy, same shape, clipped [0, 255].

No OpenCV / scipy — pure numpy + Pillow.
"""

from __future__ import annotations

import numpy as np
from PIL import ImageFilter


# ======================================================================
# Slider specifications — single source of truth for the frontend
# ======================================================================

SLIDER_SPECS = {
    "alpha": [
        {"id": "alpha", "label": "Teacher A 权重 α", "min": 0.0, "max": 1.0,
         "step": 0.01, "default": 0.5},
    ],
    "weighted": [
        # Dynamic: N-1 sliders generated per number of teachers
    ],
    "frequency": [
        {"id": "lf_a_weight", "label": "LF: Teacher A 权重", "min": 0.0, "max": 1.0,
         "step": 0.01, "default": 0.7},
        {"id": "hf_a_weight", "label": "HF: Teacher A 权重", "min": 0.0, "max": 1.0,
         "step": 0.01, "default": 0.3},
        {"id": "blur_sigma", "label": "Blur Sigma σ", "min": 0.5, "max": 20.0,
         "step": 0.1, "default": 3.0},
    ],
    "edge_guided": [
        {"id": "a_weight_edge", "label": "Edge 边缘区: Teacher A 权重", "min": 0.0, "max": 1.0,
         "step": 0.01, "default": 0.8},
        {"id": "b_weight_flat", "label": "Flat 平坦区: Teacher B 权重", "min": 0.0, "max": 1.0,
         "step": 0.01, "default": 0.7},
        {"id": "edge_threshold", "label": "Edge Threshold 边缘阈值", "min": 0.5, "max": 10.0,
         "step": 0.1, "default": 2.0},
    ],
    "pyramid": [
        {"id": "lvl0_weight", "label": "Lv0 原分辨率: Teacher A 权重",
         "min": 0.0, "max": 1.0, "step": 0.01, "default": 0.8},
        {"id": "lvl1_weight", "label": "Lv1 ½ 分辨率: Teacher A 权重",
         "min": 0.0, "max": 1.0, "step": 0.01, "default": 0.5},
        {"id": "lvl2_weight", "label": "Lv2 ¼ 分辨率: Teacher A 权重",
         "min": 0.0, "max": 1.0, "step": 0.01, "default": 0.2},
    ],
}

METHOD_LABELS = {
    "alpha": "Alpha Blend",
    "weighted": "Weighted Blend（N 教师）",
    "frequency": "Frequency Separation 频域分离",
    "edge_guided": "Edge-Guided Blend 边缘引导",
    "pyramid": "Multi-Scale Pyramid 多尺度金字塔",
}

METHOD_INFO = {
    "alpha": {
        "title": "Alpha Blend",
        "summary": "两张教师图像逐像素加权平均，最简单直观的融合方式。",
        "detail": (
            "**公式：** 结果 = α × 教师 A + (1−α) × 教师 B\n\n"
            "每个像素按固定比例混合两位教师。α = 1.0 时完全等于教师 A，"
            "α = 0.0 时完全等于教师 B。\n\n"
            "**适用场景：** 快速探索两教师的整体平衡点，感受二者差异。"
            "适合作为粗筛第一步。\n\n"
            "**参数说明：**\n"
            "- **教师 A 权重 (α)：** 教师 A 的占比。越大越偏向教师 A 的风格"
            "（如 HAT-S 的锐利边缘），越小越偏向教师 B（如 StableSR 的细腻纹理）。"
        ),
        "linked_sliders": [],
    },
    "weighted": {
        "title": "Weighted Blend 加权混合",
        "summary": "N 个教师图像按各自权重混合，权重之和为 1。",
        "detail": (
            "**公式：** 结果 = Σ wᵢ × 教师ᵢ，其中 Σ wᵢ = 1\n\n"
            "Alpha 混合的推广版，支持 3 个以上教师同时参与融合。每位教师拥有独立权重，"
            "最后一个教师的权重自动计算为 1 − 前 N−1 个权重之和。若和超过 1 则自动归一化。\n\n"
            "**适用场景：** 有 3 个以上教师来源（如 HAT-S + StableSR + 其他模型），"
            "需要探索各自对最终结果的贡献比例。\n\n"
            "**注意：** 分辨率不同的教师会自动用双线性插值缩放到第一个教师的尺寸。"
        ),
        "linked_sliders": ["sum_to_one"],
    },
    "frequency": {
        "title": "Frequency Separation 频域分离",
        "summary": "用 Gaussian 模糊将图像分解为 LF（结构/边缘）和 HF（纹理/细节），分别独立混合后重组。",
        "detail": (
            "**流程 (Pipeline):**\n"
            "1. 对两教师分别做 Gaussian blur (σ) → 提取 LF 分量（结构、边缘轮廓）\n"
            "2. 原图 − LF → HF 分量（纹理、细节）\n"
            "3. LF 用 `lf_a_weight` 混合，HF 用 `hf_a_weight` 混合\n"
            "4. 重组: result = blended_LF + blended_HF\n\n"
            "**核心思路:** 不同教师在不同频段有优势。例如 HAT-S 的 LF 更好（边缘锐利），"
            "StableSR 的 HF 更好（纹理自然）。此方法分别控制「结构从谁取」「纹理从谁取」。\n\n"
            "**权重关系:** LF 和 HF 是**两个独立频段的独立决策**，不存在数学约束。"
            "两权重设置相近时退化为普通 Alpha 混合（频域分离白做了）；差异越大，频域分离效果越明显。\n\n"
            "**参数:**\n"
            "- **lf_a_weight:** Teacher A 在 LF 中的占比。越大 = 结构/边缘越偏 A。"
            "推荐 0.75–0.85。\n"
            "- **hf_a_weight:** Teacher A 在 HF 中的占比。越小 = 纹理越偏 B。"
            "推荐 0.25–0.40。\n"
            "- **blur_sigma σ:** LF/HF 分界线。σ 越大 = 更多内容被归为「结构」"
            "（更保守地引入 B 的纹理）。典型 2–5。"
        ),
        "linked_sliders": [],
    },
    "edge_guided": {
        "title": "Edge-Guided 边缘引导融合",
        "summary": "在边缘区和平坦区使用不同的混合比例，用 Sobel 算子生成软边缘蒙版。",
        "detail": (
            "**处理流程：**\n"
            "1. 对教师 A 的灰度图计算 Sobel 梯度幅值\n"
            "2. 用 (均值 × 阈值) 归一化 → 软边缘蒙版 [0, 1]\n"
            "3. 边缘区域：偏向教师 A（保留锐利边缘）\n"
            "4. 平坦区域：偏向教师 B（获得自然纹理）\n\n"
            "**核心思路：** 边缘需要 HAT-S 的锐利度，平坦区需要 StableSR 的自然感。"
            "软蒙版确保过渡平滑，不会出现硬边界。\n\n"
            "**参数说明：**\n"
            "- **边缘区教师 A 权重：** 边缘上教师 A 的占比。越大边缘越锐利。"
            "推荐 0.85–0.95（边缘必须交给 HAT-S）。\n"
            "- **平坦区教师 B 权重：** 平坦区教师 B 的占比。越大纹理越自然。"
            "推荐 0.65–0.80。\n"
            "- **边缘检测阈值：** 边缘敏感度。越低 = 更多像素被判定为边缘。"
            "典型范围 1.5–3.0。"
        ),
        "linked_sliders": [],
    },
    "pyramid": {
        "title": "Multi-Scale Pyramid 多尺度金字塔",
        "summary": "Laplacian 金字塔：将图像分解为 3 个频带独立混合后重建，权重一致时可完美重建。",
        "detail": (
            "**处理流程 (True Laplacian Pyramid):**\n"
            "1. Gaussian 金字塔: G0(原图) → ↓G1(½) → ↓G2(¼)\n"
            "2. Laplacian 金字塔: L0 = G0 − ↑G1 (高频), L1 = G1 − ↑G2 (中频), L2 = G2 (基频)\n"
            "3. 每级独立混合: Li = wi×Li_A + (1−wi)×Li_B\n"
            "4. 合成重建: 从 L2 开始, ↑ + L1 → ↑ + L0 → 结果\n\n"
            "**核心思路:** 三个频带对应不同空间尺度。L0 控制精细纹理，L1 控制中等结构，"
            "L2 控制粗粒度布局。\n\n"
            "**数学性质:** 当 w0=w1=w2 时，完美重建为 Alpha 混合（线性性质保证插值对称抵消）。"
            "权重差异越大，各频段的独立性越明显。\n\n"
            "**参数:**\n"
            "- **Lv0 (原分辨率):** 高频纹理的混合比例\n"
            "- **Lv1 (½ 分辨率):** 中频结构的混合比例\n"
            "- **Lv2 (¼ 分辨率):** 低频基底的混合比例"
        ),
        "linked_sliders": [],
    },
}



def weighted_slider_specs(n_teachers: int) -> list[dict]:
    """Generate N-1 weight sliders for N-teacher weighted blending."""
    specs = []
    for i in range(n_teachers - 1):
        specs.append({
            "id": f"w{i}",
            "label": f"Teacher {i} 权重",
            "min": 0.0, "max": 1.0, "step": 0.01,
            "default": round(1.0 / n_teachers, 2),
        })
    return specs


# ======================================================================
# Parameter validation
# ======================================================================

def validate_params(method: str, params: dict, n_teachers: int = 2) -> dict:
    """Clamp every param to its allowed range. Returns sanitised copy."""
    if method == "weighted":
        specs = weighted_slider_specs(n_teachers)
    else:
        specs = SLIDER_SPECS.get(method, [])
    clean = {}
    for s in specs:
        val = float(params.get(s["id"], s["default"]))
        clean[s["id"]] = max(s["min"], min(s["max"], val))
    return clean


def default_params(method: str, n_teachers: int = 2) -> dict:
    """Return {param_id: default_value} for *method*."""
    if method == "weighted":
        specs = weighted_slider_specs(n_teachers)
    else:
        specs = SLIDER_SPECS.get(method, [])
    return {s["id"]: s["default"] for s in specs}


# ======================================================================
# Fusion methods
# ======================================================================

# --- 1. Simple alpha blend (2 teachers) -------------------------------------

def fusion_alpha(img_a: np.ndarray, img_b: np.ndarray, params: dict) -> np.ndarray:
    """result = alpha * A + (1-alpha) * B"""
    alpha = float(params.get("alpha", 0.5))
    blended = alpha * img_a + (1.0 - alpha) * img_b
    return np.clip(blended, 0, 255).astype(np.uint8)


# --- 2. Weighted blend (N teachers) -----------------------------------------

def fusion_weighted(images: list[np.ndarray], params: dict) -> np.ndarray:
    """result = sum(w_i * image_i), weights from N-1 sliders, last = 1 - sum.

    *images* is a list of float32 numpy arrays.  Mismatched resolutions are
    resized to match the first image via bilinear interpolation.
    """
    from PIL import Image as PILImage

    n = len(images)
    if n < 2:
        return images[0].astype(np.uint8) if images else np.zeros((1, 1, 3), dtype=np.uint8)

    # Ensure uniform size (resize to first image's dimensions)
    h0, w0 = images[0].shape[:2]
    imgs = []
    for img in images:
        if img.shape[:2] != (h0, w0):
            if img.ndim == 2:
                pil = PILImage.fromarray(img.astype(np.uint8))
            else:
                pil = PILImage.fromarray(img.astype(np.uint8))
            pil = pil.resize((w0, h0), PILImage.BILINEAR)
            imgs.append(np.array(pil, dtype=np.float32))
        else:
            imgs.append(img.astype(np.float32))

    # Collect raw weights from sliders w0..w_{n-2}
    raw = []
    for i in range(n - 1):
        raw.append(float(params.get(f"w{i}", 1.0 / n)))
    raw = [max(0.0, min(1.0, r)) for r in raw]
    remainder = 1.0 - sum(raw)
    if remainder < 0:
        total = sum(raw)
        weights = [r / total for r in raw] + [0.0]
    else:
        weights = raw + [remainder]

    blended = sum(w * img for w, img in zip(weights, imgs))
    return np.clip(blended, 0, 255).astype(np.uint8)


# --- 3. Frequency-domain blend ---------------------------------------------

def _gaussian_blur_channel(ch: np.ndarray, sigma: float) -> np.ndarray:
    """Apply Gaussian blur to a 2-D float32 array via Pillow."""
    from PIL import Image as PILImage
    img = PILImage.fromarray(np.clip(ch, 0, 255).astype(np.uint8))
    blurred = img.filter(ImageFilter.GaussianBlur(radius=sigma))
    return np.array(blurred, dtype=np.float32)


def fusion_frequency(img_a: np.ndarray, img_b: np.ndarray, params: dict) -> np.ndarray:
    """Gaussian decompose → blend LF & HF independently.

    LF = GaussianBlur(image, sigma),  HF = image - LF
    """
    lf_w = float(params.get("lf_a_weight", 0.7))
    hf_w = float(params.get("hf_a_weight", 0.3))
    sigma = float(params.get("blur_sigma", 3.0))

    blended = np.empty_like(img_a)
    for c in range(3):
        lf_a = _gaussian_blur_channel(img_a[:, :, c], sigma)
        hf_a = img_a[:, :, c] - lf_a
        lf_b = _gaussian_blur_channel(img_b[:, :, c], sigma)
        hf_b = img_b[:, :, c] - lf_b

        blended[:, :, c] = (lf_w * lf_a + (1 - lf_w) * lf_b) + \
                           (hf_w * hf_a + (1 - hf_w) * hf_b)

    return np.clip(blended, 0, 255).astype(np.uint8)


# --- 4. Edge-guided blend ---------------------------------------------------

def _sobel_magnitude(gray: np.ndarray) -> np.ndarray:
    """Central-difference Sobel magnitude (no scipy)."""
    gy = np.zeros_like(gray)
    gx = np.zeros_like(gray)
    gx[:, 1:-1] = gray[:, 2:] - gray[:, :-2]
    gy[1:-1, :] = gray[2:, :] - gray[:-2, :]
    return np.sqrt(gx ** 2 + gy ** 2 + 1e-8)


def fusion_edge_guided(img_a: np.ndarray, img_b: np.ndarray, params: dict) -> np.ndarray:
    """Edge zones → Teacher A weights; flat zones → Teacher B weights."""
    a_w = float(params.get("a_weight_edge", 0.8))
    b_w = float(params.get("b_weight_flat", 0.7))
    thresh = float(params.get("edge_threshold", 2.0))

    gray_a = img_a[:, :, 0].astype(np.float32)
    mag = _sobel_magnitude(gray_a)
    mean_mag = mag.mean()
    edge_map = np.clip(mag / (thresh * mean_mag + 1e-8), 0.0, 1.0)
    edge_map_3c = np.stack([edge_map] * 3, axis=-1)

    edge_result = a_w * img_a + (1 - a_w) * img_b
    flat_result = b_w * img_b + (1 - b_w) * img_a

    blended = edge_map_3c * edge_result + (1.0 - edge_map_3c) * flat_result
    return np.clip(blended, 0, 255).astype(np.uint8)


# --- 5. Multi-scale pyramid blend -------------------------------------------

def fusion_pyramid(img_a: np.ndarray, img_b: np.ndarray, params: dict) -> np.ndarray:
    """True Laplacian pyramid blend — lossless when all weights are equal.

    Algorithm:
      1. Build Gaussian pyramids for A and B: G0, G1=↓G0, G2=↓G1
      2. Blend each Gaussian level independently (always in [0,255])
      3. Build Laplacian from blended Gaussians, then reconstruct

    When w0=w1=w2=k: blended G0 = k*A+(1-k)*B; reconstruction exactly
    recovers this value (up/down bilinear errors cancel via pyramid synthesis).
    """
    from PIL import Image as PILImage

    def _to_pil(gray):
        return PILImage.fromarray(np.clip(gray, 0, 255).astype(np.uint8))

    def _down(gray, scale):
        h, w = gray.shape
        return np.array(_to_pil(gray).resize(
            (int(round(w * scale)), int(round(h * scale))), PILImage.BILINEAR), dtype=np.float32)

    def _up(gray, target_w, target_h):
        return np.array(_to_pil(gray).resize(
            (int(target_w), int(target_h)), PILImage.BILINEAR), dtype=np.float32)

    lw = [
        float(params.get("lvl0_weight", 0.8)),
        float(params.get("lvl1_weight", 0.5)),
        float(params.get("lvl2_weight", 0.2)),
    ]
    w0, w1, w2 = np.float32(lw[0]), np.float32(lw[1]), np.float32(lw[2])

    # Process all 3 channels independently (channels may differ slightly
    # in PNG storage, even for grayscale IR images).
    blended = np.empty_like(img_a, dtype=np.float32)
    for c in range(3):
        ga = img_a[:, :, c].astype(np.float32)
        gb = img_b[:, :, c].astype(np.float32)
        h, w = ga.shape

        # Build Gaussian pyramids
        ga0, gb0 = ga, gb
        ga1, gb1 = _down(ga, 0.5), _down(gb, 0.5)
        ga2, gb2 = _down(ga1, 0.5), _down(gb1, 0.5)
        gh1, gw1 = ga1.shape

        # Blend each Gaussian level
        g0 = w0 * ga0 + (np.float32(1) - w0) * gb0
        g1 = w1 * ga1 + (np.float32(1) - w1) * gb1
        g2 = w2 * ga2 + (np.float32(1) - w2) * gb2

        # Build Laplacian and reconstruct
        up_g1 = _up(g1, w, h)
        up_g2 = _up(g2, gw1, gh1)
        l0 = g0 - up_g1
        l1 = g1 - up_g2
        rc1 = _up(g2, gw1, gh1) + l1   # = g1
        blended[:, :, c] = _up(rc1, w, h) + l0   # = g0

    return np.clip(blended, 0, 255).astype(np.uint8)


# ======================================================================
# Dispatcher
# ======================================================================

# Pairwise methods: take exactly 2 images
PAIRWISE_FUNCTIONS = {
    "alpha": fusion_alpha,
    "frequency": fusion_frequency,
    "edge_guided": fusion_edge_guided,
    "pyramid": fusion_pyramid,
}

FUSION_FUNCTIONS = dict(PAIRWISE_FUNCTIONS)
FUSION_FUNCTIONS["weighted"] = None  # special-cased in fuse()


def get_fusion_function(method: str):
    """Return the callable for *method*, or raise ValueError."""
    if method not in FUSION_FUNCTIONS:
        raise ValueError(f"Unknown fusion method: {method!r}")
    return FUSION_FUNCTIONS[method]


def fuse(images: list[np.ndarray], method: str, params: dict,
         teacher_a: int = 0, teacher_b: int = 1) -> np.ndarray:
    """Run fusion *method* with *params* on a list of teacher images.

    For pairwise methods, *teacher_a* and *teacher_b* select which two.
    For 'weighted', all images are used.
    """
    if method == "weighted":
        params = validate_params(method, params, len(images))
        return fusion_weighted(images, params)

    if method not in PAIRWISE_FUNCTIONS:
        raise ValueError(f"Unknown fusion method: {method!r}")

    params = validate_params(method, params)
    fn = PAIRWISE_FUNCTIONS[method]
    ia = max(0, min(len(images) - 1, teacher_a))
    ib = max(0, min(len(images) - 1, teacher_b))
    return fn(images[ia].astype(np.float32), images[ib].astype(np.float32), params)
