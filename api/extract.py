"""Suminar hosted extraction function (Vercel Python).

PyMuPDF text extraction for PDFs (better two-column / reading-order fidelity
than the open-kernel pypdf path) and python-docx for .docx. Pure and
stateless: it fetches the source from a short-lived signed URL, returns the
derivative set as JSON, and holds no secrets or database access. The Node
orchestrator does embeddings, key generation, Storage uploads, and DB rows.

Contract (POST, header x-suminar-extract-secret must equal SUMINAR_EXTRACT_SECRET):
  request:  { "sourceUrl": "<signed url>", "kind": "pdf" | "docx", "ocr": bool? }
  response: { agentId, sourceHash, extractionStatus, pageCount, markdown,
              chunks: [{chunkId, agentId, chunkIndex, page, location, text, tokenEstimate}] }

With "ocr": true (PDF only, user-triggered), the text comes from the Mistral
OCR API reading the rendered pages instead of PyMuPDF reading the embedded
text layer — the cure for glyph-corrupted fonts (broken ToUnicode maps) and
scans. Requires MISTRAL_API_KEY; the source travels to Mistral for that call.
"""
import base64
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

MAX_BYTES = 256 * 1024 * 1024
WATCHDOG_SECONDS = 220  # inside both the platform's 300s kill and Node's 240s abort

# Progress marker so a timeout names the exact grinding stage instead of
# dying silently and orphaning the document in "processing" (observed live,
# 2026-07-15: one journal PDF ground past the function budget with no trace).
# The runtime executes handlers in a worker thread, so SIGALRM is unavailable
# ("signal only works in main thread"); the watchdog is a joined worker
# thread instead, with a cooperative deadline check inside the page loop.
PROGRESS = {"stage": "start"}


class ExtractionTimeout(Exception):
    pass


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# Glyph corruption from a broken ToUnicode font map lands symbols or digits
# INSIDE words — "Poli)cs", "informa)on", "Honeycu8", "e8orts" — at rates real
# prose never approaches (every ti/tt/fi ligature in the document breaks the
# same way). Two letters before the symbol keep ordinary math like f(x) and
# P(A) out; the digit rule looks only inside lowercase words, so B2B, H1N1,
# and footnote markers after a word survive.
SYMBOL_IN_WORD = re.compile(r"[A-Za-z]{2}[()\[\]{}<>|~^][A-Za-z]")
DIGIT_IN_WORD = re.compile(r"[a-z][0-9][a-z]")


def glyph_corruption_hits(text: str) -> int:
    return len(SYMBOL_IN_WORD.findall(text)) + len(DIGIT_IN_WORD.findall(text))


def extract_pdf(data: bytes):
    import fitz  # PyMuPDF

    pages = []
    empty_pages = 0
    errors = []
    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        return [], "failed", {"error": str(exc), "pageCount": 0, "emptyPages": 0}
    loop_deadline = time.monotonic() + WATCHDOG_SECONDS - 20
    for index in range(document.page_count):
        PROGRESS["stage"] = f"pdf text extraction, page {index + 1} of {document.page_count}"
        # A truncated extraction would silently misrepresent the source, so a
        # cumulative grind raises instead of returning partial pages.
        if time.monotonic() > loop_deadline:
            raise ExtractionTimeout(f"extraction budget exhausted during: {PROGRESS['stage']}")
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
    report = {"pageCount": page_count, "emptyPages": empty_pages, "totalChars": total_chars, "errors": errors}
    # Text volume can be fine while every ligature is garbage; flag dense
    # mid-word corruption for the user-triggered OCR retry rather than
    # presenting a "ready" agent that quotes "Poli)cs" verbatim.
    if status == "clean":
        full_text = "\n".join(pages)
        hits = glyph_corruption_hits(full_text)
        words = max(1, len(full_text.split()))
        report["glyphCorruptionHits"] = hits
        if hits >= 15 and hits / words >= 0.004:
            status = "partial_needs_ocr_review"
            report["glyphCorruption"] = True
    return pages, status, report


# OCR retry: Mistral reads the RENDERED pages, so a broken embedded text
# layer (bad ToUnicode map, scans) cannot corrupt it. Mirrors the open-kernel
# ocr-mistral path (scripts/ingest_pdf.py) over plain REST — the signed source
# URL is handed to Mistral directly, so the bytes never round-trip through
# this function twice.
def extract_pdf_ocr(data: bytes):
    api_key = os.environ.get("MISTRAL_API_KEY")
    if not api_key:
        raise ValueError("OCR is not configured on this deployment: MISTRAL_API_KEY is missing")
    PROGRESS["stage"] = "mistral ocr"
    # Inline the document as a base64 data URI (mirrors the open-kernel
    # ocr-mistral path) instead of handing Mistral the signed URL to fetch:
    # a 19-page / 900 KB source timed out past 180s when Mistral had to pull it
    # from Storage itself, while inline bytes OCR in a fraction of that. The
    # function already holds the bytes (downloaded for the source hash), so
    # this adds no round-trip.
    document_url = "data:application/pdf;base64," + base64.b64encode(data).decode("ascii")
    payload = json.dumps({
        "model": "mistral-ocr-latest",
        "document": {"type": "document_url", "document_url": document_url},
        "table_format": "markdown",
        "include_image_base64": False,
    }).encode("utf-8")
    request = urllib.request.Request(
        "https://api.mistral.ai/v1/ocr",
        data=payload,
        headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=200) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as exc:  # noqa: PERF203
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise ValueError(f"Mistral OCR returned {exc.code}: {detail}") from exc
    pages = [clean_text((page.get("markdown") or "")) for page in result.get("pages", [])]
    total_chars = sum(len(page) for page in pages)
    status = "clean" if total_chars >= 200 else "needs_ocr"
    return pages, status, {
        "pageCount": len(pages),
        "emptyPages": sum(1 for page in pages if len(page) < 40),
        "totalChars": total_chars,
        "ocrModel": "mistral-ocr-latest",
        "errors": [],
    }


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


def extract_payload(source_url: str, kind: str, ocr: bool = False) -> dict:
    PROGRESS["stage"] = "downloading source"
    request = urllib.request.Request(source_url, headers={"user-agent": "suminar-extract/1"})
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 (signed URL from our own Storage)
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Source exceeds the 256 MB extraction limit")

    # The bytes are downloaded even for OCR: the agent id is the hash of the
    # original, and it must land on the same agent the first extraction made.
    source_hash = hashlib.sha256(data).hexdigest()
    agent_id = f"agent_{source_hash[:24]}"
    if ocr:
        if kind != "pdf":
            raise ValueError("OCR retry supports PDF sources only")
        pages, status, report = extract_pdf_ocr(data)
    elif kind == "docx":
        PROGRESS["stage"] = "docx text extraction"
        pages, status, report = extract_docx(data)
    else:
        pages, status, report = extract_pdf(data)
    PROGRESS["stage"] = "chunking"
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
            ocr = bool(request.get("ocr"))
            if not isinstance(source_url, str) or kind not in ("pdf", "docx"):
                self._send(400, {"error": "invalid_request", "detail": "sourceUrl and kind (pdf|docx) are required"})
                return
            holder = {}

            def run() -> None:
                try:
                    holder["result"] = extract_payload(source_url, kind, ocr)
                except Exception as exc:  # noqa: BLE001
                    holder["error"] = exc

            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            worker.join(WATCHDOG_SECONDS)
            if worker.is_alive():
                # The worker cannot be killed; respond with the diagnosis and
                # let the platform reap the instance.
                self._send(500, {"error": "extraction_timeout", "detail": f"extraction timed out during: {PROGRESS['stage']}"})
                return
            if "error" in holder:
                raise holder["error"]
            self._send(200, holder["result"])
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": "extraction_failed", "detail": str(exc)})
