const $ = (sel) => document.querySelector(sel);
const msg = $("#message");

async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error(`Server returned HTML (HTTP ${res.status}) for ${method} ${path} - restart Flask / check that this route exists.`); }
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const record = (p) => el("span", { className: "rec", textContent: `${p.w}W ${p.l}L` });
let names = new Map();
let lastState = null;
let pending = null;

let prevCourts = null; // null = first render, don't announce yet

const person = (p) => {
  const label = el("span", { textContent: p.name });
  if (p.partner_id) {
    label.append(el("small", { className: "lock", textContent: `Locked with ${names.get(p.partner_id) || "partner"}` }));
  }
  return el("span", { className: "who" }, label, record(p));
};

function partnerButton(p) {
  if (p.partner_id) return button("Unlock", () => run(`/api/unpartner/${p.id}`), "quiet", `Unlock ${p.name} from partner`);
  if (pending === p.id) return button("Cancel", () => { pending = null; render(lastState); }, "quiet");
  if (pending) {
    const chooser = names.get(pending);
    return button(`Lock with ${chooser}`, () => { const a = pending; pending = null; run("/api/partner", { a, b: p.id }); },
      "", `Lock ${p.name} in as partner of ${chooser}`);
  }
  return button("Partner", () => { pending = p.id; render(lastState); }, "quiet", `Choose a partner for ${p.name}`);
}

function button(text, onclick, className = "", label = "") {
  const b = el("button", { type: "button", textContent: text, className, onclick });
  if (label) b.setAttribute("aria-label", label);
  return b;
}

function renderCourt(players, i, checkedInCount, perGame) {
  const busy = players.length > 0;
  const card = el("article", { className: busy ? "court busy" : "court" },
    el("div", { className: "court-head" }, el("h3", { textContent: `Court ${i + 1}` })));

  if (!busy) {
    const start = button("Start next game", () => run(`/api/courts/${i}/start`));
    start.disabled = checkedInCount < perGame;
    card.append(el("p", { className: "free", textContent: `Free. Needs ${perGame} checked-in players.` }),
      el("div", { className: "court-actions" }, start));
    
    // Add drop zone for empty courts
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () => {
      card.classList.remove("drag-over");
    });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      const playerId = parseInt(e.dataTransfer.getData("player-id"));
      if (playerId) {
        msg.textContent = "Cannot add player to empty court. Start a game first.";
      }
    });
    
    return card;
  }

  card.append(
    el("div", { className: "team-labels" }, el("span", { textContent: "Team 1" }), el("span", { textContent: "Team 2" })),
    courtPlayersList(players, i),
    el("div", { className: "court-actions" },
      button("Team 1 Won", () => openScoreModal(i, 1, players)),
      button("Team 2 Won", () => openScoreModal(i, 2, players)),
      button("🔊 Announce", () => announceCourt(i, players), "quiet", `Announce the players on Court ${i + 1}`),
      button("📺 Focus", () => {
        const focused = lastState && lastState.focus;
        if (focused === i) {
          unfocusCourtOnTV();
        } else {
          focusCourtOnTV(i);
        }
      }, "quiet", `Show Court ${i + 1} fullscreen on TV`),
      button("Cancel", () => run(`/api/courts/${i}/finish`, { winner: null }), "quiet")));
  
  // Add drop zone for busy courts (replace player)
  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    card.classList.add("drag-over");
  });
  card.addEventListener("dragleave", () => {
    card.classList.remove("drag-over");
  });
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("drag-over");
    const playerId = parseInt(e.dataTransfer.getData("player-id"));
    if (playerId && players.length > 0) {
      // Open replace modal with the dragged player as the replacement
      const queuePlayer = lastState.queue.find(p => p.id === playerId);
      if (queuePlayer && queuePlayer.checked_in) {
        // Let user choose who to replace
        openReplaceModalForDrag(i, queuePlayer);
      }
    }
  });
  
  return card;
}

/* ── Court player tools: announce, drag-to-swap teams, replace player ───────── */
let courtDragging = false;
let dragFrom = null;   // { court, idx }
let swapPick = null;   // { court, id }  (tap-to-swap fallback for touch screens)

function announceCourt(i, p) {
  if (typeof window.soundUnlocked !== "undefined" && !window.soundUnlocked) {
    msg.textContent = "Press 🔊 Enable (Voice bar) first to hear announcements.";
    return;
  }
  msg.textContent = "";
  if (typeof window.announce === "function") {
    window.announce(`Court ${i + 1}. Team 1: ${p[0].name}, ${p[1].name}. Team 2: ${p[2].name}, ${p[3].name}.`);
  }
}

function focusCourtOnTV(courtIdx) {
  // Post focused court to server (sets ui["focus"])
  run("/api/focus", { court: courtIdx });
  msg.textContent = `📺 Court ${courtIdx + 1} is now focused on TV display. Press 📺 Focus again to unfocus.`;
  setTimeout(() => { if (msg.textContent.includes('focused on TV')) msg.textContent = ''; }, 3000);
}

function unfocusCourtOnTV() {
  // Post null to server to clear focus
  run("/api/focus", { court: null });
  msg.textContent = '📺 Unfocused - showing all courts on TV';
  setTimeout(() => { msg.textContent = ''; }, 2000);
}

/* Server calls for the new actions. Needs POST /api/courts/<i>/swap and /replace on the Flask side. */
async function courtAction(path, body) {
  courtDragging = false; dragFrom = null; swapPick = null;
  await run(path, body);
  if (/unexpected token|json|not found/i.test(msg.textContent)) {
    msg.textContent = "This action needs the new server endpoint (swap / replace) — not added yet.";
  }
}
function swapPlayers(courtIdx, a, b) {
  courtAction(`/api/courts/${courtIdx}/swap`, { a: a.id, b: b.id });
}

function courtPlayersList(players, courtIdx) {
  const teamOf = (idx) => (idx < 2 ? 0 : 1);
  const ul = el("ul", { className: "court-players" });
  const clearMarks = () => ul.querySelectorAll(".drop-ok").forEach((x) => x.classList.remove("drop-ok"));

  players.forEach((p, idx) => {
    const repl = button("↻", () => openReplaceModal(courtIdx, p), "icon-btn", `Replace ${p.name}`);
    repl.title = "Replace this player";
    repl.draggable = false;
    const li = el("li", {
      draggable: true,
      className: swapPick && swapPick.court === courtIdx && swapPick.id === p.id ? "swap-pick" : "",
      title: "Drag to the other team to swap (or tap two players)",
    }, el("span", { textContent: p.name }), record(p), repl);

    li.addEventListener("dragstart", (e) => {
      courtDragging = true; dragFrom = { court: courtIdx, idx };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(idx));
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => {
      courtDragging = false; dragFrom = null;
      li.classList.remove("dragging"); clearMarks();
    });
    li.addEventListener("dragover", (e) => {
      if (dragFrom && dragFrom.court === courtIdx && teamOf(dragFrom.idx) !== teamOf(idx)) {
        e.preventDefault(); e.dataTransfer.dropEffect = "move"; li.classList.add("drop-ok");
      }
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-ok"));
    li.addEventListener("drop", (e) => {
      e.preventDefault(); clearMarks();
      if (dragFrom && dragFrom.court === courtIdx && teamOf(dragFrom.idx) !== teamOf(idx)) {
        swapPlayers(courtIdx, players[dragFrom.idx], p);
      }
    });

    /* Tap fallback: tap one player, then tap a player on the other team */
    li.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (swapPick && swapPick.court === courtIdx && swapPick.id !== p.id) {
        const other = players.findIndex((x) => x.id === swapPick.id);
        if (other >= 0 && teamOf(other) !== teamOf(idx)) { swapPlayers(courtIdx, players[other], p); return; }
      }
      swapPick = (swapPick && swapPick.id === p.id) ? null : { court: courtIdx, id: p.id };
      render(lastState);
    });
    ul.append(li);
  });
  return ul;
}

function openReplaceModalForDrag(courtIdx, inPlayer) {
  const old = document.getElementById("replace-modal-overlay");
  if (old) old.remove();
  
  const court = lastState ? lastState.courts[courtIdx] : [];
  const close = button("✕", () => overlay.remove());
  close.className = "modal-close";

  const body = court.length
    ? el("ul", { className: "replace-list" }, ...court.map((p) => {
        const b = button(`Replace ${p.name}`, () => {
          overlay.remove();
          courtAction(`/api/courts/${courtIdx}/replace`, { out_id: p.id, in_id: inPlayer.id });
        }, "quiet", `Put ${inPlayer.name} in place of ${p.name}`);
        return el("li", {}, b);
      }))
    : el("p", { textContent: "No players on this court." });

  const modal = el("div", { className: "score-modal" },
    el("div", { className: "modal-header" },
      el("h2", { textContent: `Drag ${inPlayer.name} to Court ${courtIdx + 1}` }), close),
    el("p", { textContent: "Choose who to replace:" }),
    body);
  const overlay = el("div", { id: "replace-modal-overlay", className: "modal-overlay" }, modal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  const onKey = (e) => { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

function openReplaceModal(courtIdx, outP) {
  const old = document.getElementById("replace-modal-overlay");
  if (old) old.remove();
  const waiting = lastState ? lastState.queue : [];

  const close = button("✕", () => overlay.remove());
  close.className = "modal-close";

  const body = waiting.length
    ? el("ul", { className: "replace-list" }, ...waiting.map((q) => {
        const b = button(q.checked_in ? q.name : `${q.name} (not checked in)`, () => {
          overlay.remove();
          courtAction(`/api/courts/${courtIdx}/replace`, { out_id: outP.id, in_id: q.id });
        }, "quiet", `Put ${q.name} in place of ${outP.name}`);
        b.disabled = !q.checked_in;
        return el("li", {}, b, record(q));
      }))
    : el("p", { textContent: "No one is waiting in the queue." });

  const modal = el("div", { className: "score-modal" },
    el("div", { className: "modal-header" },
      el("h2", { textContent: `Court ${courtIdx + 1} — replace ${outP.name}` }), close),
    el("p", { textContent: `${outP.name} goes back to the queue. Pick who takes their place:` }),
    body);
  const overlay = el("div", { id: "replace-modal-overlay", className: "modal-overlay" }, modal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  const onKey = (e) => { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

/* ── Score Modal ──────────────────────────────────────────────── */
function openScoreModal(courtIdx, winner, players) {
  // Remove any existing modal
  const old = document.getElementById("score-modal-overlay");
  if (old) old.remove();

  const winTeam  = winner === 1 ? [players[0], players[1]] : [players[2], players[3]];
  const loseTeam = winner === 1 ? [players[2], players[3]] : [players[0], players[1]];
  const winLabel  = winner === 1 ? "Team 1" : "Team 2";
  const loseLabel = winner === 1 ? "Team 2" : "Team 1";

  // Score inputs
  const sWin  = el("input", { type: "number", min: "0", max: "99", value: "",
    className: "modal-score-input", placeholder: "0", id: "modal-score-win",
    "aria-label": `${winLabel} score` });
  const sLose = el("input", { type: "number", min: "0", max: "99", value: "",
    className: "modal-score-input", placeholder: "0", id: "modal-score-lose",
    "aria-label": `${loseLabel} score` });

  function playerNames(team) {
    return team.map(p => el("span", { className: "modal-player", textContent: p.name }));
  }

  const confirmBtn = button("Confirm", () => {
    const v1 = parseInt(sWin.value),  v2 = parseInt(sLose.value);
    const score1 = isNaN(v1) ? null : v1;
    const score2 = isNaN(v2) ? null : v2;
    overlay.remove();
    run(`/api/courts/${courtIdx}/finish`, { winner, score1, score2 });
  });
  confirmBtn.className = "modal-confirm";

  const skipBtn = button("Skip Score", () => {
    overlay.remove();
    run(`/api/courts/${courtIdx}/finish`, { winner, score1: null, score2: null });
  });
  skipBtn.className = "quiet";

  const cancelBtn = button("✕", () => overlay.remove());
  cancelBtn.className = "modal-close";

  const modal = el("div", { className: "score-modal" },
    el("div", { className: "modal-header" },
      el("h2", { textContent: `Court ${courtIdx + 1} — ${winLabel} Won` }),
      cancelBtn
    ),
    el("div", { className: "modal-teams" },
      el("div", { className: "modal-team modal-team-win" },
        el("div", { className: "modal-team-label", textContent: `🏆 ${winLabel}` }),
        ...playerNames(winTeam),
        el("div", { className: "modal-score-wrap" },
          el("label", { htmlFor: "modal-score-win", className: "modal-score-label", textContent: "Score" }),
          sWin
        )
      ),
      el("div", { className: "modal-vs", textContent: "VS" }),
      el("div", { className: "modal-team modal-team-lose" },
        el("div", { className: "modal-team-label", textContent: loseLabel }),
        ...playerNames(loseTeam),
        el("div", { className: "modal-score-wrap" },
          el("label", { htmlFor: "modal-score-lose", className: "modal-score-label", textContent: "Score" }),
          sLose
        )
      )
    ),
    el("div", { className: "modal-actions" }, confirmBtn, skipBtn)
  );

  const overlay = el("div", { id: "score-modal-overlay", className: "modal-overlay" }, modal);

  // Close on backdrop click
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  // Close on Escape
  const onKey = (e) => { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);

  // Focus first input
  setTimeout(() => sWin.focus(), 50);
}

function checkinButton(p) {
  const on = p.checked_in;
  const btn = button(
    on ? "✓ In" : "Check In",
    () => run(`/api/checkin/${p.id}`),
    on ? "checkin-on" : "checkin-off",
    on ? `${p.name} is checked in` : `Check in ${p.name}`
  );
  if (on) btn.disabled = true;   // already checked in - use Break / Leave instead
  return btn;
}

function render(data) {
  lastState = data;
  if (courtDragging) return;   // keep the DOM stable while a name is being dragged
  const { queue, courts, breaks, per_game, max_courts, checked_in_count,
          queue_join_times, server_time } = data;

  // Compute client↔server time offset once per render
  const serverOffset = server_time ? (Date.now() / 1000) - server_time : 0;

  names = new Map([...queue, ...courts.flat(), ...breaks].map((p) => [p.id, p.name]));
  if (pending && !queue.some((p) => p.id === pending && !p.partner_id)) pending = null;

  // ── Announce when a court goes from empty → busy ──
  if (prevCourts !== null) {
    courts.forEach((c, i) => {
      const wasEmpty = !prevCourts[i] || prevCourts[i].length === 0;
      const nowBusy = c && c.length > 0;
      if (wasEmpty && nowBusy && typeof window.announce === "function") {
        window.announce(
          `Court ${i + 1}. ` +
          `Team 1: ${c[0].name}, ${c[1].name}. ` +
          `Team 2: ${c[2].name}, ${c[3].name}.`
        );
      }
    });
  }
  prevCourts = courts.map((c) => (c ? [...c] : []));

  $("#courts").replaceChildren(...courts.map((c, i) => renderCourt(c, i, checked_in_count, per_game)));
  renderDecks(data);

  $("#add-court").disabled = courts.length >= max_courts;
  $("#remove-court").disabled = courts.length <= 1 || courts[courts.length - 1].length > 0;

  $("#queue-count").textContent = queue.length ? `(${queue.length})` : "";

  // Sort queue by wait time (longest waiting first)
  const sortedQueue = [...queue].sort((a, b) => {
    const joinTsA = queue_join_times ? queue_join_times[String(a.id)] : null;
    const joinTsB = queue_join_times ? queue_join_times[String(b.id)] : null;
    
    // If both have join times, sort by oldest first (ascending)
    if (joinTsA !== null && joinTsB !== null) {
      return joinTsA - joinTsB;
    }
    
    // If only A has a time, A comes first
    if (joinTsA !== null) return -1;
    // If only B has a time, B comes first
    if (joinTsB !== null) return 1;
    // If neither has a time, maintain original order
    return 0;
  });

  // Search + check-in counts for the waiting list
  const searchEl = $("#queue-search");
  const term = searchEl ? searchEl.value.trim().toLowerCase() : "";
  const queuePos = new Map(sortedQueue.map((p, idx) => [p.id, idx + 1]));   // real place in line
  const visibleQueue = term ? sortedQueue.filter((p) => p.name.toLowerCase().includes(term)) : sortedQueue;
  const inCount = queue.filter((p) => p.checked_in).length;
  const statsEl = $("#queue-stats");
  if (statsEl) {
    statsEl.replaceChildren(
      el("span", { className: "stat stat-in", textContent: `✓ ${inCount} checked in` }),
      el("span", { className: "stat stat-out", textContent: `✗ ${queue.length - inCount} not checked in` }),
      ...(term ? [el("span", { className: "stat stat-found", textContent: `Showing ${visibleQueue.length} of ${queue.length}` })] : []));
  }

  $("#queue").replaceChildren(
    ...(visibleQueue.length
      ? visibleQueue.map((p) => {
          const joinTs = queue_join_times && queue_join_times[String(p.id)];
          const waitEl = joinTs ? (() => {
            const elapsed = Math.floor((Date.now() / 1000) - serverOffset - joinTs);
            const m = Math.floor(elapsed / 60), s = elapsed % 60;
            const txt = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
            const span = el("span", { className: "wait-badge", textContent: txt });
            span.dataset.start = joinTs;
            span.dataset.offset = serverOffset;
            if (elapsed >= 15 * 60) span.classList.add("wait-long");
            return span;
          })() : null;

          const li = el("li", { draggable: true },
            el("span", { className: "spot", textContent: queuePos.get(p.id) }),
            person(p),
            ...(waitEl ? [waitEl] : []),
            checkinButton(p),
            partnerButton(p),
            button("Break", () => run(`/api/break/${p.id}`), "quiet", `${p.name} takes a break`),
            button("Leave", () => run(`/api/leave/${p.id}`), "quiet", `Remove ${p.name} from the queue`));
          
          // Add drag events for moving to court
          li.addEventListener("dragstart", (e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("player-id", p.id);
            li.classList.add("dragging");
          });
          li.addEventListener("dragend", () => {
            li.classList.remove("dragging");
          });
          
          return li;
        })
      : [el("li", { className: "empty", textContent: term ? `No waiting player matches "${searchEl.value.trim()}".` : "No one waiting. Join to get in line." })]));

  $("#break-h").hidden = breaks.length === 0;
  if (document.getElementById("breaks-section")) document.getElementById("breaks-section").hidden = breaks.length === 0;
  $("#breaks").replaceChildren(
    ...breaks.map((p) => el("li", {},
      person(p),
      button("Resume", () => run(`/api/resume/${p.id}`), "quiet", `${p.name} is back from break`),
      button("Leave", () => run(`/api/leave/${p.id}`), "quiet", `Remove ${p.name}`))));
}

async function importReclub(e) {
  e.preventDefault();
  const urlInput = document.getElementById('reclub-url');
  const statusEl = document.getElementById('reclub-status');
  const url = urlInput.value.trim();
  if (!url) return;
  statusEl.style.color = "var(--ink-muted)";
  statusEl.textContent = "⌛ Fetching players from ReClub...";
  try {
    const data = await api("/api/reclub-import", "POST", { url });
    statusEl.style.color = "green";
    statusEl.textContent = `✅ Added ${data.added_count} player(s) to queue.`;
    urlInput.value = "";
    render(data);
  } catch (err) {
    statusEl.style.color = "var(--error)";
    statusEl.textContent = "❌ " + err.message;
  }
}

async function run(path, body) {  try {
    msg.textContent = "";
    render(await api(path, "POST", body));
  } catch (err) {
    msg.textContent = err.message;
  }
}

$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#name");
  await run("/api/join", { name: input.value });
  if (!msg.textContent) input.value = "";
  input.focus();
});
$("#queue-search").addEventListener("input", () => { if (lastState) render(lastState); });
$("#add-court").onclick = () => run("/api/courts");
$("#remove-court").onclick = () => run("/api/courts/remove");
$("#reset-btn").onclick = () => {
  if (confirm("Reset everything? This clears all players, courts, and records.")) {
    deckSig = null;
    prevCourts = null;
    run("/api/reset");
  }
};

let refreshFailed = false;
async function refresh() {
  try {
    render(await api("/api/state"));
    if (refreshFailed) { msg.textContent = ""; refreshFailed = false; }
  } catch (err) {
    msg.textContent = err.message;
    refreshFailed = true;
  }
}
refresh();
setInterval(refresh, 3000);

/* ── Up next decks (4 editable games) ───────────────────────────
 * Slots 0-1 = Team 1, slots 2-3 = Team 2. Everything lives on the server.
 * Auto-fill: longest waiting first, then avoid repeat partners/opponents. */
let deckSig = null;

function renderDecks(data) {
  const deckEl = $("#deck");
  if (!deckEl) return;
  const { queue, courts, decks } = data;
  if (!decks) return;

  // Don't rebuild while a dropdown is open, or the list would close under the user's finger.
  const ae = document.activeElement;
  if (ae && deckEl.contains(ae) && ae.tagName === "SELECT") return;

  const inDeck = new Set(decks.flatMap((d) => d.slots.filter(Boolean).map((p) => p.id)));
  const joinTs = data.queue_join_times || {};
  const pool = queue
    .filter((p) => p.checked_in && !inDeck.has(p.id))
    .sort((a, b) => (joinTs[String(a.id)] ?? Infinity) - (joinTs[String(b.id)] ?? Infinity));

  const sig = JSON.stringify([decks, pool.map((p) => [p.id, p.name, p.w, p.l]), courts.map((c) => c.length === 0)]);
  if (sig === deckSig) return;
  deckSig = sig;

  const toolbar = el("div", { className: "decks-toolbar" },
    button("Auto-fill all decks", () => run("/api/decks/fill-all"), "", "Fill every deck automatically"),
    button("Clear all", () => run("/api/decks/clear-all"), "quiet", "Empty every deck"),
    el("span", { className: "decks-hint", textContent: "Longest waiting first · avoids repeat partners & opponents" }));

  function slotCell(deckIdx, slotIdx, p) {
    const cell = el("div", { className: p ? "deck-slot filled" : "deck-slot" });
    if (p) {
      cell.append(
        el("span", { className: "deck-slot-name", textContent: p.name }),
        record(p),
        button("✕", () => run(`/api/decks/${deckIdx}/slot`, { slot: slotIdx, player_id: null }), "quiet deck-x", `Remove ${p.name}`));
      return cell;
    }
    const sel = el("select", { className: "deck-select" });
    sel.setAttribute("aria-label", `Choose player for deck ${deckIdx + 1}, slot ${slotIdx + 1}`);
    sel.append(el("option", { value: "", textContent: "Choose…" }));
    pool.forEach((q) => sel.append(el("option", { value: String(q.id), textContent: `${q.name} (${q.w}W ${q.l}L)` })));
    sel.addEventListener("change", () => {
      if (sel.value) run(`/api/decks/${deckIdx}/slot`, { slot: slotIdx, player_id: parseInt(sel.value) });
    });
    const auto = button("Auto", () => run(`/api/decks/${deckIdx}/fill`, { slot: slotIdx }), "quiet deck-auto",
      "Fill this slot with the best available player");
    cell.append(sel, auto);
    return cell;
  }

  const cards = decks.map((d, i) => {
    const sendBtns = courts.map((c, ci) => {
      if (c.length !== 0) return null;
      const b = button(`C${ci + 1}`, () => run(`/api/decks/${i}/start`, { court: ci }), "", `Send deck ${i + 1} to Court ${ci + 1}`);
      b.disabled = !d.complete;
      return b;
    }).filter(Boolean);

    return el("div", { className: "court deck-card" },
      el("div", { className: "court-head" },
        el("h3", { textContent: `Deck ${i + 1}` }),
        el("div", { className: "deck-head-btns" },
          button("Auto-fill", () => run(`/api/decks/${i}/fill`, {}), "quiet", `Fill empty slots of deck ${i + 1}`),
          button("Clear", () => run(`/api/decks/${i}/clear`), "quiet", `Empty deck ${i + 1}`))),
      el("div", { className: "deck-teams" },
        el("div", { className: "deck-team" },
          el("div", { className: "deck-team-label", textContent: "Team 1" }),
          slotCell(i, 0, d.slots[0]), slotCell(i, 1, d.slots[1])),
        el("div", { className: "deck-team" },
          el("div", { className: "deck-team-label", textContent: "Team 2" }),
          slotCell(i, 2, d.slots[2]), slotCell(i, 3, d.slots[3]))),
      el("div", { className: "deck-send" },
        el("span", { className: "deck-send-label", textContent: d.complete ? "Send to:" : "Fill all 4 slots to send" }),
        ...(sendBtns.length ? sendBtns : [el("span", { className: "deck-send-label", textContent: "no free court" })])));
  });

  deckEl.replaceChildren(toolbar, el("div", { className: "decks-grid" }, ...cards));
}

/* ── Recent matches (edit scores) ─────────────────────────────── */
// Styles live here (not in index.html) so the modal always looks right, whichever files are deployed.
const MATCH_CSS = `
#matches-modal-overlay .score-modal { width:min(640px,96vw); max-height:88vh; padding:1.3rem 1.4rem 1.1rem; display:flex; flex-direction:column; }
#matches-modal-overlay .modal-header { margin-bottom:0.3rem; }
#matches-modal-overlay .match-help { margin:0 0 0.8rem; font-size:0.82rem; line-height:1.4; color:var(--ink-muted); }
#matches-modal-overlay .matches-status { margin:0.4rem 0; font-size:0.88rem; color:var(--ink-muted); }
#matches-modal-overlay .matches-list { overflow-y:auto; min-height:0; padding:0 0.2rem 0.2rem 0; }
#matches-modal-overlay .match-card { padding:0.65rem 0.9rem 0.85rem; margin:0 0 0.6rem; border:1px solid var(--beige-dark);
  border-radius:12px; background:rgba(255,255,255,0.55); }
#matches-modal-overlay .match-top { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; margin-bottom:0.55rem; min-height:1.9rem; }
#matches-modal-overlay .match-meta { font-size:0.72rem; font-weight:700; letter-spacing:0.09em; text-transform:uppercase; color:var(--ink-muted); }
#matches-modal-overlay .match-top-right { display:flex; align-items:center; gap:0.5rem; }
#matches-modal-overlay .match-note { font-size:0.76rem; color:var(--ink-muted); }
#matches-modal-overlay .match-note.err { color:var(--error); font-weight:600; }
#matches-modal-overlay button.match-save { padding:0.25rem 0.95rem; font-size:0.8rem; }
#matches-modal-overlay .match-row { display:grid; grid-template-columns:minmax(0,1fr) auto auto auto minmax(0,1fr); align-items:center; gap:0.5rem; }
#matches-modal-overlay .match-team { display:flex; flex-direction:column; gap:0.1rem; min-width:0; overflow-wrap:anywhere;
  font-size:0.92rem; font-weight:600; line-height:1.25; color:var(--ink-muted); }
#matches-modal-overlay .match-team.left { text-align:right; }
#matches-modal-overlay .match-team.right { text-align:left; }
#matches-modal-overlay .match-team.win { color:var(--ink); font-weight:700; }
#matches-modal-overlay input.match-score { width:3.3rem; min-width:0; height:2.5rem; padding:0; box-sizing:border-box; text-align:center;
  font:800 1.25rem/1 var(--font-display); color:var(--ink); background:#fff; border:2px solid var(--beige-dark); border-radius:10px;
  box-shadow:none; -moz-appearance:textfield; }
#matches-modal-overlay input.match-score::-webkit-outer-spin-button,
#matches-modal-overlay input.match-score::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
#matches-modal-overlay input.match-score.win { border-color:var(--lime-dark); background:#f3f9e8; }
#matches-modal-overlay input.match-score:focus { border-color:var(--lime-dark); box-shadow:0 0 0 3px rgba(134,184,43,0.28); }
#matches-modal-overlay .match-dash { font-weight:700; color:var(--ink-muted); }
`;

function ensureMatchStyles() {
  if (document.getElementById("match-modal-style")) return;
  document.head.appendChild(el("style", { id: "match-modal-style", textContent: MATCH_CSS }));
}

function openMatchesModal() {
  ensureMatchStyles();
  const old = document.getElementById("matches-modal-overlay");
  if (old) old.remove();

  const list = el("div", { className: "matches-list" });
  const status = el("p", { className: "matches-status", textContent: "Loading…" });
  const closeBtn = button("✕", () => close());
  closeBtn.className = "modal-close";

  const modal = el("div", { className: "score-modal" },
    el("div", { className: "modal-header" }, el("h2", { textContent: "Recent matches" }), closeBtn),
    el("p", { className: "match-help", textContent: "Change a score, then press Save. Standings update automatically. A higher score for the other team switches the winner." }),
    status, list);

  const overlay = el("div", { id: "matches-modal-overlay", className: "modal-overlay" }, modal);
  function close() { overlay.remove(); document.removeEventListener("keydown", onKey); }
  const onKey = (e) => { if (e.key === "Escape") close(); };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);

  function numInput(v, label) {
    const i = el("input", { type: "number", min: "0", max: "99", value: String(v), className: "match-score" });
    i.setAttribute("aria-label", label);
    i.addEventListener("focus", () => i.select());
    return i;
  }

  function teamCell(names, side) {
    return el("div", { className: `match-team ${side}` },
      ...names.map((n) => el("span", { textContent: n })));
  }

  function renderGames(games) {
    list.innerHTML = "";
    status.textContent = games.length ? "" : "No finished matches yet.";
    games.forEach((g) => {
      const i1 = numInput(g.score1, `${g.team1.join(" and ")} score`);
      const i2 = numInput(g.score2, `${g.team2.join(" and ")} score`);
      const left = teamCell(g.team1, "left"), right = teamCell(g.team2, "right");
      const note = el("span", { className: "match-note" });

      const save = button("Save", async () => {
        save.disabled = true; note.textContent = "Saving…"; note.classList.remove("err");
        try {
          const data = await api(`/api/games/${g.id}/score`, "POST", { score1: i1.value, score2: i2.value });
          renderGames(data.games);
          if (typeof refresh === "function") refresh();
        } catch (err) {
          note.textContent = err.message; note.classList.add("err");
          save.disabled = false;
        }
      }, "match-save");
      save.disabled = true;                       // nothing to save until a score changes

      function sync() {
        const a = parseInt(i1.value), b = parseInt(i2.value);
        const w1 = !isNaN(a) && !isNaN(b) && a > b, w2 = !isNaN(a) && !isNaN(b) && b > a;
        i1.classList.toggle("win", w1); left.classList.toggle("win", w1);
        i2.classList.toggle("win", w2); right.classList.toggle("win", w2);
      }
      const onEdit = () => {
        sync();
        const changed = i1.value !== String(g.score1) || i2.value !== String(g.score2);
        save.disabled = !changed;
        if (changed) note.textContent = "";
      };
      i1.addEventListener("input", onEdit);
      i2.addEventListener("input", onEdit);
      sync();

      const when = g.ts ? new Date(g.ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
      const top = el("div", { className: "match-top" },
        el("span", { className: "match-meta", textContent: `Court ${g.court}${when ? " · " + when : ""}` }),
        el("div", { className: "match-top-right" }, note, save));
      const row = el("div", { className: "match-row" },
        left, i1, el("span", { className: "match-dash", textContent: "–" }), i2, right);
      list.append(el("div", { className: "match-card" }, top, row));
    });
  }

  api("/api/games").then((d) => renderGames(d.games))
    .catch((err) => { status.textContent = err.message; status.style.color = "var(--error)"; });
}
$("#matches-btn").addEventListener("click", openMatchesModal);