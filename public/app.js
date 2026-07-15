const $ = (selector) => document.querySelector(selector);
let lastPreview;

function status(message, error = false) {
  const node = $("#status");
  node.textContent = message;
  node.style.background = error ? "#8b2417" : "#171512";
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 4000);
}
async function api(url, options) {
  const response = await fetch(url, options);
  if (response.status === 204) return undefined;
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}

async function refresh() {
  const agents = await api("/api/agents");
  $("#agent-count").textContent = agents.length;
  $("#agents").innerHTML = agents.map(({agentId, card, extractionStatus}) => `<article class="card">
    <h3>@${escapeHtml(card.handle)}</h3><p>${escapeHtml(card.sourceIdentity.title)}</p><p>${escapeHtml(card.sourceIdentity.authors.join(", "))}</p>
    <code>${escapeHtml(extractionStatus)} · v${escapeHtml(card.agentVersion)} · ${extractionStatus === "remote" ? escapeHtml(card.origin) : "local"}</code>
    ${extractionStatus === "clean" || extractionStatus === "remote" ? "" : `<button class="small-button ocr-button" data-agent-id="${escapeHtml(agentId)}">Retry with Mistral OCR</button>`}
    ${extractionStatus !== "remote" ? `<details><summary>Edit representative metadata</summary><form class="agent-edit" data-agent-id="${escapeHtml(agentId)}">
      <label>Display name<input name="displayName" value="${escapeHtml(card.displayName)}"></label>
      <label>@handle<input name="handle" value="${escapeHtml(card.handle)}"></label>
      <label>Title<input name="title" value="${escapeHtml(card.sourceIdentity.title)}"></label>
      <label>Authors<input name="authors" value="${escapeHtml(card.sourceIdentity.authors.join("; "))}"></label>
      <label>Year<input name="year" type="number" value="${escapeHtml(card.sourceIdentity.year || "")}"></label>
      <label>Citation<input name="citation" value="${escapeHtml(card.sourceIdentity.citation || "")}"></label>
      <button>Save metadata</button>
    </form></details>` : `<button class="small-button remove-remote" data-handle="${escapeHtml(card.handle)}">Remove remote agent</button>`}
  </article>`).join("") || "<p>No sources ingested or added.</p>";
}

$("#ingest-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  data.set("embed", form.embed.checked ? "true" : "false");
  try {
    const result = await api("/api/ingest", {method:"POST", body:data});
    status(`Created @${result.card.handle}`);
    form.reset();
    await refresh();
  } catch (error) { status(error.message, true); }
});

$("#agents").addEventListener("submit", async (event) => {
  if (!event.target.matches(".agent-edit")) return;
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  try {
    await api(`/api/agents/${form.dataset.agentId}`, {method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({
      displayName:data.get("displayName"), handle:data.get("handle"), title:data.get("title"),
      authors:String(data.get("authors") || "").split(";").map((value) => value.trim()).filter(Boolean),
      year:data.get("year") ? Number(data.get("year")) : null, citation:data.get("citation"),
    })});
    await refresh();
    status("Source-agent metadata updated");
  } catch (error) { status(error.message, true); }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  try {
    if (button.matches(".ocr-button")) {
      await api(`/api/agents/${button.dataset.agentId}/ocr-mistral`, {method:"POST"});
      await refresh();
      status("OCR derivative rebuilt");
    }
    if (button.matches(".remove-remote")) {
      await api(`/api/remote/${encodeURIComponent(button.dataset.handle)}`, {method:"DELETE"});
      await refresh();
      status("Remote source agent removed");
    }
    if (button.matches("#check-remotes")) {
      const results = await api("/api/remote/check", {method:"POST"});
      status(results.length ? results.map((item) => `@${item.handle}: ${item.status}`).join("; ") : "No remote origins to check", results.some((item) => item.status !== "current"));
    }
  } catch (error) { status(error.message, true); }
});

$("#remote-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const manifestUrl = new FormData(event.currentTarget).get("manifestUrl");
  try {
    lastPreview = await api("/api/remote/preview", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({manifestUrl})});
    const {card} = lastPreview;
    $("#remote-preview").innerHTML = `<div class="warning">${escapeHtml(lastPreview.firstContactWarning)}</div><article class="card">
      <h3>@${escapeHtml(card.handle)}</h3><p><strong>${escapeHtml(card.sourceIdentity.title)}</strong></p>
      <p>Origin: ${escapeHtml(card.origin)}</p><p>Operator: ${escapeHtml(card.operator.name || "Declared in card")}</p>
      <p>Retention: ${escapeHtml(card.memoryAndRetention.retentionSummary)}</p><button id="add-remote">Add this source agent</button>
    </article>`;
    $("#add-remote").onclick = async () => {
      try {
        await api("/api/remote", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({manifestUrl:lastPreview.manifestUrl, expectedManifestDigest:lastPreview.manifestDigest})});
        status("Remote source agent added");
        $("#remote-preview").innerHTML = "";
        await refresh();
      } catch (error) { status(error.message, true); }
    };
  } catch (error) { status(error.message, true); }
});

refresh().catch((error) => status(error.message, true));
