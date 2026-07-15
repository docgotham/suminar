#!/usr/bin/env python3
"""Immutable PDF ingestion for Suminar.

This script owns only private source artifacts. The TypeScript service turns its
JSON result into a public-safe agent card and signed local-agent manifest.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import urllib.request

from pypdf import PdfReader


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return (slug or "source")[:80]


def clean_text(text: str) -> str:
    text = text.replace("\x00", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip()


def safe_yaml_scalar(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def extract_pdf(path: Path) -> tuple[list[str], str, dict]:
    try:
        reader = PdfReader(str(path))
    except Exception as exc:
        return [], "failed", {"error": str(exc), "pageCount": 0, "emptyPages": 0}

    pages: list[str] = []
    empty_pages = 0
    errors: list[str] = []
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = clean_text(page.extract_text() or "")
        except Exception as exc:
            text = ""
            errors.append(f"page {index}: {exc}")
        if len(text) < 40:
            empty_pages += 1
        pages.append(text)

    total_chars = sum(len(page) for page in pages)
    page_count = len(pages)
    if total_chars < 200:
        status = "needs_ocr"
    elif page_count and empty_pages / page_count > 0.45:
        status = "partial_needs_ocr_review"
    else:
        status = "clean"
    return pages, status, {
        "pageCount": page_count,
        "emptyPages": empty_pages,
        "totalChars": total_chars,
        "errors": errors,
    }


def split_chunks(text: str, max_chars: int = 1800) -> list[str]:
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", text) if part.strip()]
    chunks: list[str] = []
    current: list[str] = []
    length = 0
    for paragraph in paragraphs:
        if len(paragraph) > max_chars:
            if current:
                chunks.append("\n\n".join(current))
                current, length = [], 0
            for start in range(0, len(paragraph), max_chars):
                piece = paragraph[start : start + max_chars].strip()
                if piece:
                    chunks.append(piece)
            continue
        projected = length + len(paragraph) + (2 if current else 0)
        if current and projected > max_chars:
            chunks.append("\n\n".join(current))
            current, length = [paragraph], len(paragraph)
        else:
            current.append(paragraph)
            length = projected
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def build_chunks(agent_id: str, pages: list[str]) -> list[dict]:
    records: list[dict] = []
    chunk_index = 0
    for page_number, page in enumerate(pages, start=1):
        for text in split_chunks(page):
            if len(text) < 40:
                continue
            chunk_id = "chunk_" + hashlib.sha256(
                f"{agent_id}\n{chunk_index}\n{text[:120]}".encode("utf-8")
            ).hexdigest()[:24]
            records.append(
                {
                    "chunkId": chunk_id,
                    "agentId": agent_id,
                    "chunkIndex": chunk_index,
                    "page": page_number,
                    "location": f"page {page_number}",
                    "text": text,
                    "tokenEstimate": max(1, round(len(text) / 4)),
                }
            )
            chunk_index += 1
    return records


def write_json_atomic(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def write_jsonl_atomic(path: Path, values: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for value in values:
            handle.write(json.dumps(value, ensure_ascii=False) + "\n")
    temporary.replace(path)


def copy_immutable(source: Path, destination: Path, expected_hash: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if sha256_file(destination) != expected_hash:
            raise RuntimeError(f"Immutable destination exists with different content: {destination}")
        return
    with source.open("rb") as src, destination.open("xb") as dst:
        shutil.copyfileobj(src, dst, length=1024 * 1024)
    try:
        destination.chmod(stat.S_IREAD)
    except OSError:
        pass


def embed_chunks(chunks: list[dict], output: Path, model: str) -> None:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required when --embed is used")
    rows: list[dict] = []
    for start in range(0, len(chunks), 100):
        batch = chunks[start : start + 100]
        request = urllib.request.Request(
            "https://api.openai.com/v1/embeddings",
            data=json.dumps({"model": model, "input": [row["text"] for row in batch]}).encode("utf-8"),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))
        for chunk, item in zip(batch, payload["data"], strict=True):
            rows.append({"chunkId": chunk["chunkId"], "model": model, "embedding": item["embedding"]})
    write_jsonl_atomic(output, rows)


def markdown_document(metadata: dict, source_hash: str, status: str, pages: list[str]) -> str:
    authors = metadata["authors"]
    frontmatter = [
        "---",
        f"source_id: {safe_yaml_scalar(metadata['agentId'])}",
        f"title: {safe_yaml_scalar(metadata['title'])}",
        "authors:",
        *[f"  - {safe_yaml_scalar(author)}" for author in authors],
        f"year: {metadata['year'] if metadata.get('year') else 'null'}",
        f"citation: {safe_yaml_scalar(metadata.get('citation') or '')}",
        f"page_count: {len(pages)}",
        f"source_sha256: {source_hash}",
        "extraction_method: pypdf",
        f"extraction_status: {status}",
        "---",
        "",
        f"# {metadata['title']}",
        "",
        "## Extracted Text",
        "",
    ]
    body: list[str] = []
    for page_number, page in enumerate(pages, start=1):
        body.extend([f"<!-- page: {page_number} -->", "", page, ""])
    return "\n".join(frontmatter + body).rstrip() + "\n"


def ingest(args: argparse.Namespace) -> int:
    source = Path(args.pdf).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    data_dir = Path(args.data_dir).resolve()
    source_hash = sha256_file(source)
    agent_id = f"agent_{source_hash[:24]}"

    try:
        pdf_metadata = PdfReader(str(source)).metadata or {}
    except Exception:
        pdf_metadata = {}
    title = args.title or str(pdf_metadata.get("/Title") or source.stem).strip()
    raw_authors = args.authors or str(pdf_metadata.get("/Author") or "")
    authors = [value.strip() for value in re.split(r"[;|]", raw_authors) if value.strip()]
    year = int(args.year) if args.year else None
    handle = args.handle or slugify("-".join(filter(None, [authors[0] if authors else "source", str(year or "")])) )
    display_name = args.display_name or (f"{authors[0]} {year}" if authors and year else title)

    originals = data_dir / "private" / "originals"
    markdown_dir = data_dir / "private" / "markdown"
    chunks_dir = data_dir / "private" / "chunks"
    embeddings_dir = data_dir / "private" / "embeddings"
    reports_dir = data_dir / "private" / "reports"
    original = originals / f"{agent_id}.pdf"
    copy_immutable(source, original, source_hash)

    pages, status, extraction_report = extract_pdf(original)
    metadata = {
        "agentId": agent_id,
        "title": title,
        "authors": authors,
        "year": year,
        "citation": args.citation or "",
        "edition": args.edition or "",
        "doiOrIsbn": args.doi_or_isbn or "",
        "handle": handle,
        "displayName": display_name,
    }
    markdown_path = markdown_dir / f"{agent_id}.md"
    chunks_path = chunks_dir / f"{agent_id}.jsonl"
    embeddings_path = embeddings_dir / f"{agent_id}.jsonl"
    report_path = reports_dir / f"{agent_id}.json"
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path.write_text(markdown_document(metadata, source_hash, status, pages), encoding="utf-8")
    chunks = build_chunks(agent_id, pages)
    write_jsonl_atomic(chunks_path, chunks)
    if args.embed and chunks:
        embed_chunks(chunks, embeddings_path, args.embedding_model)

    result = {
        **metadata,
        "sourceHash": source_hash,
        "extractionStatus": status,
        "sourceIdentity": {
            "title": title,
            "authors": authors,
            **({"edition": args.edition} if args.edition else {}),
            **({"doiOrIsbn": args.doi_or_isbn} if args.doi_or_isbn else {}),
            **({"year": year} if year else {}),
            **({"citation": args.citation} if args.citation else {}),
            "pageCount": len(pages),
        },
        "privateArtifacts": {
            "originalPdf": str(original),
            "markdown": str(markdown_path),
            "chunks": str(chunks_path),
            **({"embeddings": str(embeddings_path)} if embeddings_path.exists() else {}),
            "extractionReport": str(report_path),
        },
        "extractionReport": extraction_report,
    }
    write_json_atomic(report_path, result)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if status != "failed" else 2


def ocr_mistral(args: argparse.Namespace) -> int:
    try:
        from mistralai import Mistral
    except ImportError as exc:
        raise RuntimeError("Install the optional mistralai package from requirements.txt") from exc

    api_key = os.environ.get("MISTRAL_API_KEY")
    if not api_key:
        raise RuntimeError("MISTRAL_API_KEY is required for OCR retry")
    data_dir = Path(args.data_dir).resolve()
    report_path = data_dir / "private" / "reports" / f"{args.agent_id}.json"
    result = json.loads(report_path.read_text(encoding="utf-8"))
    original = Path(result["privateArtifacts"]["originalPdf"])
    encoded = base64.b64encode(original.read_bytes()).decode("ascii")
    client = Mistral(api_key=api_key)
    response = client.ocr.process(
        model="mistral-ocr-latest",
        document={"type": "document_url", "document_url": f"data:application/pdf;base64,{encoded}"},
        table_format="markdown",
        include_image_base64=False,
    )
    pages = [clean_text(getattr(page, "markdown", "") or "") for page in response.pages]
    if not pages or sum(len(page) for page in pages) < 200:
        raise RuntimeError("Mistral OCR returned too little text to replace the current derivative")

    metadata = {
        "agentId": result["agentId"],
        "title": result["title"],
        "authors": result["authors"],
        "year": result.get("year"),
        "citation": result.get("citation") or "",
    }
    markdown_path = Path(result["privateArtifacts"]["markdown"])
    chunks_path = Path(result["privateArtifacts"]["chunks"])
    text = markdown_document(metadata, result["sourceHash"], "clean", pages).replace(
        "extraction_method: pypdf", "extraction_method: mistral-ocr-latest"
    )
    markdown_path.write_text(text, encoding="utf-8")
    chunks = build_chunks(result["agentId"], pages)
    write_jsonl_atomic(chunks_path, chunks)
    result["extractionStatus"] = "clean"
    result["sourceIdentity"]["pageCount"] = len(pages)
    result["extractionReport"] = {
        "pageCount": len(pages),
        "totalChars": sum(len(page) for page in pages),
        "ocrModel": "mistral-ocr-latest",
    }
    write_json_atomic(report_path, result)
    print(json.dumps(result, ensure_ascii=False))
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Suminar private PDF ingestion")
    sub = root.add_subparsers(dest="command", required=True)
    ingest_parser = sub.add_parser("ingest")
    ingest_parser.add_argument("pdf")
    ingest_parser.add_argument("--data-dir", default="data")
    ingest_parser.add_argument("--title")
    ingest_parser.add_argument("--authors", help="Separate multiple authors with semicolons")
    ingest_parser.add_argument("--year", type=int)
    ingest_parser.add_argument("--citation")
    ingest_parser.add_argument("--edition")
    ingest_parser.add_argument("--doi-or-isbn")
    ingest_parser.add_argument("--handle")
    ingest_parser.add_argument("--display-name")
    ingest_parser.add_argument("--embed", action="store_true")
    ingest_parser.add_argument("--embedding-model", default="text-embedding-3-small")
    ingest_parser.set_defaults(func=ingest)

    ocr_parser = sub.add_parser("ocr-mistral")
    ocr_parser.add_argument("agent_id")
    ocr_parser.add_argument("--data-dir", default="data")
    ocr_parser.set_defaults(func=ocr_mistral)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        return int(args.func(args))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
