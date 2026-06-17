"""Semantic search for Vault vaults using local fastembed embeddings.

Embeds note content into 384-dimensional vectors (all-MiniLM-L6-v2) and caches
them in .obsidian/semantic-search-cache.json per vault. Only re-embeds notes
whose content hash has changed since the last run.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
TOP_K_DEFAULT = 20

# ── Lazy model singleton ──────────────────────────────────────

_model = None
_model_name = None


def _get_model():
    """Lazy-load the fastembed TextEmbedding model (singleton)."""
    global _model, _model_name
    if _model is not None:
        return _model

    model_name = os.getenv("FASTEMBED_MODEL", DEFAULT_MODEL)
    _model_name = model_name

    try:
        from fastembed import TextEmbedding
        from src.constants import FASTEMBED_CACHE_DIR
    except ImportError as e:
        raise RuntimeError(
            "fastembed is not installed. Run: pip install fastembed"
        ) from e

    cache_dir = FASTEMBED_CACHE_DIR
    os.makedirs(cache_dir, exist_ok=True)

    # Windows broken-symlink self-heal (mirrors src/embeddings.py)
    if os.name == "nt":
        import glob, shutil
        for onnx in glob.glob(os.path.join(cache_dir, "**", "*.onnx"), recursive=True):
            if os.path.islink(onnx) and not os.path.exists(onnx):
                root = onnx
                while os.path.basename(root) and not os.path.basename(root).startswith("models--"):
                    parent = os.path.dirname(root)
                    if parent == root:
                        break
                    root = parent
                if os.path.basename(root).startswith("models--"):
                    logger.warning("Clearing broken symlink cache: %s", root)
                    shutil.rmtree(root, ignore_errors=True)

    logger.info("Loading fastembed model: %s", model_name)
    _model = TextEmbedding(model_name=model_name, cache_dir=cache_dir)
    return _model


# ── Cache helpers ───────────────────────────────────────────────

def _cache_path(vault_path: str) -> Path:
    """Path to the per-vault embedding cache JSON."""
    return Path(vault_path) / ".obsidian" / "semantic-search-cache.json"


def _content_hash(text: str) -> str:
    """Stable hash for note content."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def _load_cache(vault_path: str) -> Dict[str, Any]:
    """Load cached embeddings from disk."""
    path = _cache_path(vault_path)
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning("Failed to load embedding cache: %s", e)
    return {"version": 1, "model": None, "entries": {}, "ts": 0}


def _save_cache(vault_path: str, cache: Dict[str, Any]) -> None:
    """Persist embedding cache to disk."""
    path = _cache_path(vault_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cache, f, separators=(",", ":"))


# ── Embedding ─────────────────────────────────────────────────

def _embed_texts(texts: List[str]) -> np.ndarray:
    """Embed a list of texts. Returns (N, dim) float32 array."""
    model = _get_model()
    vectors = list(model.embed(texts))
    return np.array(vectors, dtype="float32")


def _build_embeddings(
    vault_path: str, notes: List[Dict[str, Any]], force: bool = False
) -> Tuple[np.ndarray, List[str]]:
    """Build or update embeddings for all notes. Returns (vectors, note_ids).

    Uses the cache to skip unchanged notes.  If *force* is True, re-embeds
    everything.
    """
    cache = _load_cache(vault_path)
    model_name = os.getenv("FASTEMBED_MODEL", DEFAULT_MODEL)

    # If model changed, invalidate everything
    if cache.get("model") != model_name:
        cache = {"version": 1, "model": model_name, "entries": {}, "ts": 0}
        force = True

    entries = cache.get("entries", {})
    to_embed: List[Tuple[int, str, str]] = []  # (idx, note_id, text)
    note_ids: List[str] = []

    for idx, note in enumerate(notes):
        note_id = note["id"]
        note_ids.append(note_id)
        text = _note_text_for_embedding(note)
        h = _content_hash(text)

        ent = entries.get(note_id)
        if not force and ent and ent.get("hash") == h:
            continue  # unchanged, reuse cached vector
        to_embed.append((idx, note_id, text))

    if to_embed:
        logger.info("Embedding %d/%d notes for vault %s", len(to_embed), len(notes), vault_path)
        texts = [t for (_, _, t) in to_embed]
        # fastembed.embed returns a generator; batch internally
        vectors = _embed_texts(texts)

        for (idx, note_id, text), vec in zip(to_embed, vectors):
            entries[note_id] = {
                "hash": _content_hash(text),
                "vec": vec.tolist(),
            }

        cache["entries"] = entries
        cache["model"] = model_name
        cache["ts"] = time.time()
        _save_cache(vault_path, cache)
    else:
        logger.debug("All embeddings up-to-date for vault %s", vault_path)

    # Build the full matrix in note order
    dim = len(next(iter(entries.values()))["vec"]) if entries else 384
    matrix = np.zeros((len(notes), dim), dtype="float32")
    for idx, note_id in enumerate(note_ids):
        ent = entries.get(note_id)
        if ent:
            matrix[idx] = np.array(ent["vec"], dtype="float32")

    # L2-normalise so cosine similarity = dot product
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1, norms)
    matrix = matrix / norms

    return matrix, note_ids


def _note_text_for_embedding(note: Dict[str, Any]) -> str:
    """Extract searchable text from a note dict."""
    parts = []
    title = note.get("title", "")
    if title:
        parts.append(title)
    content = note.get("content", "")
    if content:
        parts.append(content)
    tags = note.get("tags", [])
    if tags:
        parts.append(" ".join(f"#{t}" for t in tags))
    return "\n".join(parts)


# ── Search ────────────────────────────────────────────────────

def _cosine_similarity(query_vec: np.ndarray, note_matrix: np.ndarray) -> np.ndarray:
    """Compute cosine similarity between query and all note vectors."""
    # Both are L2-normalised, so cosine sim = dot product
    return note_matrix @ query_vec


def semantic_search(
    vault_path: str,
    notes: List[Dict[str, Any]],
    query: str,
    top_k: int = TOP_K_DEFAULT,
    force_rebuild: bool = False,
) -> List[Dict[str, Any]]:
    """Search notes by semantic similarity to *query*.

    Returns a list of note dicts enriched with a ``score`` field (0.0–1.0).
    """
    if not notes:
        return []
    if not query or not query.strip():
        return []

    # Build / refresh embeddings
    note_matrix, note_ids = _build_embeddings(vault_path, notes, force=force_rebuild)

    # Embed query
    q_vec = _embed_texts([query.strip()])[0]
    q_norm = np.linalg.norm(q_vec)
    if q_norm == 0:
        return []
    q_vec = q_vec / q_norm

    # Score all notes
    scores = _cosine_similarity(q_vec, note_matrix)

    # Get top-k
    top_indices = np.argsort(scores)[::-1][:top_k]
    id_to_note = {n["id"]: n for n in notes}

    results = []
    for idx in top_indices:
        note_id = note_ids[idx]
        note = id_to_note.get(note_id)
        if note and scores[idx] > 0:
            result = dict(note)
            result["score"] = float(round(scores[idx], 4))
            results.append(result)

    return results


# ── Public helpers used by routes ─────────────────────────────

def invalidate_semantic_cache(vault_path: str) -> None:
    """Delete the embedding cache so it rebuilds from scratch next search."""
    path = _cache_path(vault_path)
    if path.exists():
        try:
            path.unlink()
            logger.info("Invalidated semantic search cache for %s", vault_path)
        except Exception as e:
            logger.warning("Failed to invalidate semantic cache: %s", e)


def get_embedding_stats(vault_path: str, notes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Return cache coverage stats without rebuilding."""
    cache = _load_cache(vault_path)
    entries = cache.get("entries", {})
    cached = sum(1 for n in notes if n["id"] in entries)
    return {
        "total_notes": len(notes),
        "cached": cached,
        "needs_embedding": len(notes) - cached,
        "model": cache.get("model") or os.getenv("FASTEMBED_MODEL", DEFAULT_MODEL),
        "cache_path": str(_cache_path(vault_path)),
    }
