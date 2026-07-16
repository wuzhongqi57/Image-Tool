"""Central configuration for the Image Fusion Tool.

All paths and defaults live here — no hardcoded values elsewhere.
Edit this file to point at a different dataset or change defaults.
"""

import os

# ---------------------------------------------------------------------------
# Dataset paths
# ---------------------------------------------------------------------------
DATASET_BASE = os.path.join("D:", os.sep, "wuzq", "datasets", "IR_640")

TRAIN_DIRS = {
    "lq": os.path.join(DATASET_BASE, "train", "LQ_X1"),
    "hat": os.path.join(DATASET_BASE, "train", "HQ_X2"),
    "sr": os.path.join(DATASET_BASE, "train", "StableSR_HQ_X2"),
}

TEST_DIRS = {
    "lq": os.path.join(DATASET_BASE, "test", "LQ_X1"),
    "hat": os.path.join(DATASET_BASE, "test", "HQ_X2"),
    "sr": os.path.join(DATASET_BASE, "test", "StableSR_HQ_X2"),
}

# ---------------------------------------------------------------------------
# Tool paths (relative to this tool's root)
# ---------------------------------------------------------------------------
TOOL_ROOT = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(TOOL_ROOT, "output")
PRESETS_DIR = os.path.join(TOOL_ROOT, "presets")
DEFAULT_PRESETS_FILE = os.path.join(PRESETS_DIR, "default_presets.json")

# ---------------------------------------------------------------------------
# Image cache
# ---------------------------------------------------------------------------
CACHE_SIZE = 4  # triplets to hold in memory (~47 MB each in uint8)

# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
HOST = "127.0.0.1"
PORT = 5000
DEBUG = True

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEFAULT_DATASET = "test"      # "train" or "test"
DEFAULT_METHOD = "alpha"      # "alpha" | "frequency" | "edge_guided" | "pyramid"
DEFAULT_IMAGE_INDEX = 0

# ---------------------------------------------------------------------------
# Pillow JPEG export quality (1-100).  95 = near-lossless for judging.
# ---------------------------------------------------------------------------
JPEG_QUALITY = 95
