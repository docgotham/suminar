"""Suminar hosted extraction function (Vercel Python).

PyMuPDF text extraction for PDFs (better two-column / reading-order fidelity
than the open-kernel pypdf path) and python-docx for .docx. Pure and
stateless: it fetches the source from a short-lived signed URL, returns the
derivative set as JSON, and holds no secrets or database access. The Node
orchestrator does embeddings, key generation, Storage uploads, and DB rows.

Contract (POST, header x-suminar-extract-secret must equal SUMINAR_EXTRACT_SECRET):
  request:  { "sourceUrl": "<signed url>", "kind": "pdf" | "docx" }
  response: { agentId, sourceHash, extractionStatus, pageCount, markdown,
              chunks: [{chunkId, agentId, chunkIndex, page, location, text, tokenEstimate}] }
"""
import hashlib
import json
import os
import re
import urllib.request
from http.server import BaseHTTPRequestHandler

MAX_BYTES = 256 * 1024 * 1024


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_pdf(data: bytes):
    import fitz  # PyMuPDF

    pages = []
    empty_pages = 0
    errors = []
    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        return [], "failed", {"error": str(exc), "pageCount": 0, "emptyPages": 0}
    for index in range(document.page_count):
        try:
            text = clean_text(document.load_page(index).get_text("text") or "")
        except Exception as exc:  # noqa: BLE001
            text = ""
            errors.append(f"page {index + 1}: {exc}")
        if len(text) < 40:
            empty_pages += 1
        pages.append(text)
    document.close()

    total_chars = sum(len(page) for page in pages)
    page_count = len(pages)
    if total_chars < 200:
        status = "needs_ocr"
    elif page_count and empty_pages / page_count > 0.45:
        status = "partial_needs_ocr_review"
    else:
        status = "clean"
    return pages, status, {"pageCount": page_count, "emptyPages": empty_pages, "totalChars": total_chars, "errors": errors}


def extract_docx(data: bytes):
    import io
    import docx  # python-docx

    document = docx.Document(io.BytesIO(data))
    paragraphs = [clean_text(paragraph.text) for paragraph in document.paragraphs if paragraph.text.strip()]
    body = "\n\n".join(paragraphs)
    status = "clean" if len(body) >= 200 else "needs_ocr"
    # A .docx has no reliable pages; treat the whole document as one page.
    return [body], status, {"pageCount": 1, "emptyPages": 0 if body else 1, "totalChars": len(body), "errors": []}


def split_chunks(text: str, max_chars: int = 1800):
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", text) if part.strip()]
    chunks = []
    current = []
    length = 0
    for paragraph in paragraphs:
        if len(paragraph) > max_chars:
            if current:
                chunks.append("\n\n".join(current))
                current, length = [], 0
            for start in range(0, len(paragraph), max_chars):
                piece = paragraph[start:start + max_chars].strip()
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


def build_chunks(agent_id: str, pages):
    records = []
    chunk_index = 0
    for page_number, page in enumerate(pages, start=1):
        for text in split_chunks(page):
            if len(text) < 40:
                continue
            chunk_id = "chunk_" + hashlib.sha256(
                f"{agent_id}\n{chunk_index}\n{text[:120]}".encode("utf-8")
            ).hexdigest()[:24]
            records.append({
                "chunkId": chunk_id,
                "agentId": agent_id,
                "chunkIndex": chunk_index,
                "page": page_number,
                "location": f"page {page_number}",
                "text": text,
                "tokenEstimate": max(1, round(len(text) / 4)),
            })
            chunk_index += 1
    return records


def markdown_document(agent_id: str, status: str, pages) -> str:
    header = f"<!-- agent: {agent_id} -->\n<!-- extraction: {status} -->\n"
    body = "\n\n".join(f"<!-- page: {index} -->\n{page}" for index, page in enumerate(pages, start=1))
    return f"{header}\n{body}\n"


def extract_payload(source_url: str, kind: str) -> dict:
    request = urllib.request.Request(source_url, headers={"user-agent": "suminar-extract/1"})
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 (signed URL from our own Storage)
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Source exceeds the 256 MB extraction limit")

    source_hash = hashlib.sha256(data).hexdigest()
    agent_id = f"agent_{source_hash[:24]}"
    if kind == "docx":
        pages, status, report = extract_docx(data)
    else:
        pages, status, report = extract_pdf(data)
    chunks = build_chunks(agent_id, pages)
    return {
        "agentId": agent_id,
        "sourceHash": source_hash,
        "extractionStatus": status,
        "pageCount": len(pages),
        "markdown": markdown_document(agent_id, status, pages),
        "chunks": chunks,
        "extractionReport": report,
    }


class handler(BaseHTTPRequestHandler):
    def _send(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        secret = os.environ.get("SUMINAR_EXTRACT_SECRET")
        if not secret or self.headers.get("x-suminar-extract-secret") != secret:
            self._send(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            request = json.loads(self.rfile.read(length) or b"{}")
            source_url = request.get("sourceUrl")
            kind = request.get("kind", "pdf")
            if not isinstance(source_url, str) or kind not in ("pdf", "docx"):
                self._send(400, {"error": "invalid_request", "detail": "sourceUrl and kind (pdf|docx) are required"})
                return
            self._send(200, extract_payload(source_url, kind))
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": "extraction_failed", "detail": str(exc)})
