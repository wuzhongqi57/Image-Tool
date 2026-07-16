"""Image loading for arbitrary teacher directories.

No hard dependencies beyond Pillow + numpy.
Supports 2–N teacher directories with filename-intersection matching.
"""

import os
from collections import OrderedDict

import numpy as np
from PIL import Image


class ImageCache:
    """Fixed-size LRU cache: key=(dirs_tuple, basename) → list of uint8 arrays."""

    def __init__(self, max_size: int = 4):
        self._max_size = max_size
        self._cache: OrderedDict = OrderedDict()

    def get(self, key) -> list | None:
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        return None

    def put(self, key, value: list):
        if key in self._cache:
            self._cache.move_to_end(key)
        else:
            if len(self._cache) >= self._max_size:
                self._cache.popitem(last=False)
        self._cache[key] = value

    def clear(self):
        self._cache.clear()

    def __len__(self):
        return len(self._cache)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _load_image_uint8(path: str) -> np.ndarray:
    """Load an image, return uint8 numpy (H, W, C)."""
    if not os.path.exists(path):
        raise FileNotFoundError(f"Image not found: {path}")
    return np.array(Image.open(path), dtype=np.uint8)


def validate_teacher_dirs(dirs: list[str]) -> dict:
    """Validate a list of teacher directories.

    Returns
    -------
    {
        "valid": bool,
        "names": ["short_name1", "short_name2", ...],   # display names
        "common_basenames": ["00000010", ...],           # intersection without .png
        "total": int,
        "warnings": ["...", ...],
        "per_dir_counts": [1000, 1000, ...],
    }
    """
    warnings = []
    per_dir_files = []
    per_dir_names = []

    if not dirs or len(dirs) < 2:
        return {"valid": False, "names": [], "common_basenames": [], "total": 0,
                "warnings": ["Need at least 2 teacher directories."],
                "per_dir_counts": []}

    for d in dirs:
        d = d.strip()
        if not d:
            warnings.append("Empty directory path.")
            continue
        if not os.path.isdir(d):
            warnings.append(f"Directory not found: {d}")
            per_dir_files.append(set())
            per_dir_names.append(os.path.basename(d) or d)
            continue

        pngs = {os.path.splitext(f)[0] for f in os.listdir(d) if f.lower().endswith(".png")}
        per_dir_files.append(pngs)
        per_dir_names.append(os.path.basename(d.rstrip("/\\")) or d)

    if not per_dir_files:
        return {"valid": False, "names": per_dir_names, "common_basenames": [], "total": 0,
                "warnings": warnings, "per_dir_counts": [0] * len(dirs)}

    # Union of all filename sets (not intersection — allow unmatched filenames)
    all_files = per_dir_files[0]
    for s in per_dir_files[1:]:
        all_files = all_files | s
    all_sorted = sorted(all_files)

    # Per-file teacher availability: {basename: [True, False, ...]}
    teacher_map = {}
    for basename in all_sorted:
        teacher_map[basename] = [basename in files for files in per_dir_files]

    # Warnings about non-overlapping files
    intersection = per_dir_files[0]
    for s in per_dir_files[1:]:
        intersection = intersection & s
    mismatch_count = len(all_sorted) - len(intersection)
    if mismatch_count > 0:
        for i, files in enumerate(per_dir_files):
            only_here = files - intersection
            if only_here:
                sample = sorted(only_here)[:3]
                warnings.append(f"[{per_dir_names[i]}] {len(only_here)} images unique to this dir, e.g. {sample}")
        warnings.append(f"Total: {len(all_sorted)} images (union), {len(intersection)} common across all")

    return {
        "valid": len(all_sorted) > 0,
        "names": per_dir_names,
        "common_basenames": all_sorted,
        "total": len(all_sorted),
        "warnings": warnings,
        "per_dir_counts": [len(s) for s in per_dir_files],
        "teacher_map": teacher_map,   # NEW: which teachers have which images
    }


def load_teachers(dirs: list[str], basename: str,
                  cache: ImageCache | None = None) -> tuple[list, list[int]]:
    """Load available teacher images for *basename* from all *dirs*.

    Returns (images, indices) where images is a list of uint8 numpy arrays
    and indices maps each image back to its original dir position.
    Dir positions with no matching file are silently skipped.
    """
    key = (tuple(dirs), basename)
    if cache is not None:
        hit = cache.get(key)
        if hit is not None:
            return hit

    fname = basename + ".png"
    images = []
    indices = []
    for i, d in enumerate(dirs):
        path = os.path.join(d, fname)
        if os.path.exists(path):
            images.append(_load_image_uint8(path))
            indices.append(i)

    result = (images, indices)
    if cache is not None and images:
        cache.put(key, result)
    return result


def list_images(directory: str) -> list[str]:
    """List all image files (PNG/BMP/JPG) in a directory, sorted."""
    exts = {".png", ".bmp", ".jpg", ".jpeg"}
    return sorted([f for f in os.listdir(directory)
                   if os.path.splitext(f)[1].lower() in exts])


def load_lq(lq_dir: str, basename: str,
            target_size: tuple | None = None) -> np.ndarray | None:
    """Load the LQ image for *basename* from *lq_dir*, or None if missing.

    Tries common image extensions (.png, .bmp, .jpg).
    If *target_size* is given as (W, H), the image is upscaled to that size.
    """
    if not lq_dir or not os.path.isdir(lq_dir):
        return None
    for ext in (".png", ".bmp", ".jpg", ".jpeg"):
        path = os.path.join(lq_dir, basename + ext)
        if os.path.exists(path):
            img = _load_image_uint8(path)
            if target_size is not None:
                tw, th = target_size
                if img.shape[1] != tw or img.shape[0] != th:
                    img = np.array(Image.fromarray(img).resize((tw, th), Image.BILINEAR),
                                   dtype=np.uint8)
            return img
    return None
