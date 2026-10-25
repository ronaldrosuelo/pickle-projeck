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

let deckLoaded = false;
let currentDeckPlayerIds = [];  // Store just IDs, not full objects
let currentDeckTeamSplit = null;  // Store the locked team assignment
let deckSentJustNow = false;  // Flag to prevent auto-gen right after sending to court
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

// Track last deck signature to avoid duplicate sends
let lastDeckSig = null;

// Publish in team order (Team 1 first, then Team 2) so the TV shows the same teams as the deck
function publishCurrentDeck() {
  const ids = currentDeckTeamSplit
    ? [...currentDeckTeamSplit[0], ...currentDeckTeamSplit[1]]
    : currentDeckPlayerIds;
  publishDeck(ids);
}

function publishDeck(playerIds) {
  // Create a signature of the current deck to detect changes
  const sig = JSON.stringify(playerIds);
  if (sig === lastDeckSig) return;  // Already sent this deck
  
  lastDeckSig = sig;
  run("/api/deck", { ids: playerIds });
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

/* Partner-aware deck picker.
 * Treats locked pairs as a single unit so both always appear together.
 * Returns an array of `perGame` player objects, or falls back to random. */
function pickDeckGroup(queue, perGame, queueJoinTimes = null, serverOffset = 0) {
  // Build units: locked pairs count as one unit of size 2
  const seen = new Set();
  const units = [];
  for (const p of queue) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.partner_id && queue.some(q => q.id === p.partner_id)) {
      const partner = queue.find(q => q.id === p.partner_id);
      seen.add(p.partner_id);
      units.push([p, partner]);
    } else {
      units.push([p]);
    }
  }

  // Sort units by wait time (longest waiting first) if we have join times
  if (queueJoinTimes && serverOffset !== undefined) {
    units.sort((unitA, unitB) => {
      // Use the first player's wait time for comparison
      const joinTsA = queueJoinTimes[String(unitA[0].id)];
      const joinTsB = queueJoinTimes[String(unitB[0].id)];
      
      if (joinTsA !== undefined && joinTsB !== undefined) {
        return joinTsA - joinTsB; // Earliest join time first (longest waiting)
      }
      if (joinTsA !== undefined) return -1;
      if (joinTsB !== undefined) return 1;
      return 0;
    });
  } else {
    // Fallback to shuffling if no join times
    units.sort(() => Math.random() - 0.5);
  }

  const picked = [];
  for (const unit of units) {
    if (picked.length + unit.length <= perGame) {
      picked.push(...unit);
      if (picked.length === perGame) break;
    }
  }

  // If we couldn't fill exactly (e.g. all remaining are pairs and only 1 slot left),
  // fall back to simple random slice
  if (picked.length < perGame) {
    return [...queue].sort(() => Math.random() - 0.5).slice(0, perGame);
  }
  return picked;
}

function renderDeckInner(queue, perGame, courts) {
  const deckEl = $("#deck");
  if (!deckEl) return;

  // Only checked-in players are eligible for picking new decks
  const checkedIn = queue.filter(p => p.checked_in);

  // Only show "need more players" if deck is NOT loaded yet
  if (!deckLoaded && checkedIn.length < perGame) {
    currentDeckPlayerIds = [];
    const need = perGame - checkedIn.length;
    const msg = queue.length < perGame
      ? `Need ${perGame - queue.length} more player(s) in queue.`
      : `Need ${need} more player(s) to check in.`;

    const loadBtn = button("Show Next Deck", null, "", "Show the next group of players");
    loadBtn.disabled = true;

    deckEl.replaceChildren(
      el("div", { className: "court deck-card" },
        el("div", { className: "court-head" }, el("h3", { textContent: "Up next deck" })),
        el("p", { className: "deck-empty", textContent: msg }),
        el("div", { className: "court-actions", style: "margin-top: 0.6rem;" }, loadBtn)
      )
    );
    return;
  }

  if (!deckLoaded) {
    const loadBtn = button("Show Next Deck", () => {
      const deck = pickDeckGroup(checkedIn, perGame);
      currentDeckPlayerIds = deck.map(p => p.id);  // Store only IDs
      
      // Compute and lock team split
      function computeTeamSplit(players) {
        const [a, b, c, d] = players;
        const opts = [[[a,b],[c,d]], [[a,c],[b,d]], [[a,d],[b,c]]];
        const valid = opts.filter(([t1, t2]) => {
          const ok = (team) => team.every(p =>
            !p.partner_id || team.some(q => q.id === p.partner_id)
          );
          return ok(t1) && ok(t2);
        });
        const chosen = valid.length ? valid[Math.floor(Math.random() * valid.length)] : opts[0];
        return chosen.map(team => team.map(p => p.id));  // Return as IDs
      }
      
      currentDeckTeamSplit = computeTeamSplit(deck);
      deckLoaded = true;
      publishCurrentDeck();  // Send deck to server
      render(lastState);
    }, "", "Show the next group of players");
    loadBtn.disabled = checkedIn.length < perGame;

    deckEl.replaceChildren(
      el("div", { className: "court deck-card" },
        el("div", { className: "court-head" }, el("h3", { textContent: "Up next deck" })),
        el("p", { className: "deck-empty", textContent: "Click below to reveal a random group." }),
        el("div", { className: "court-actions", style: "margin-top: 0.6rem;" }, loadBtn)
      )
    );
    return;
  }

  // Check if any deck player is completely gone from queue (left/finished)
  const allQueueIds = new Set(queue.map(p => p.id));
  
  // Only regenerate if a player in the deck is COMPLETELY missing from queue
  const missingFromQueue = currentDeckPlayerIds.filter(id => !allQueueIds.has(id));
  if (missingFromQueue.length > 0 && deckLoaded) {
    // A player left queue completely — pick new deck
    const deck = pickDeckGroup(checkedIn, perGame);
    currentDeckPlayerIds = deck.map(p => p.id);
    currentDeckTeamSplit = null;
  }
  
  // NOTE: Do NOT regenerate deck just because wait times changed or players unchecked
  // The deck stays locked until a player actually LEAVES the queue completely

  // Get the actual player objects by ID, maintaining the locked order
  const nextPlayers = currentDeckPlayerIds.map(id => queue.find(p => p.id === id)).filter(Boolean);

  // Safety check: if nextPlayers suddenly has fewer players, only reset if they left queue entirely
  if (nextPlayers.length < currentDeckPlayerIds.length && deckLoaded) {
    // Some deck players aren't showing up - verify they're actually gone from queue
    const stillMissing = currentDeckPlayerIds.filter(id => !queue.some(p => p.id === id));
    if (stillMissing.length === 0) {
      // All players still in queue, just rendering issue - don't reset
      // This prevents the deck from disappearing during refresh cycles
    } else if (stillMissing.length > 0) {
      // Players actually left — regenerate deck
      const deck = pickDeckGroup(checkedIn, perGame);
      currentDeckPlayerIds = deck.map(p => p.id);
      currentDeckTeamSplit = null;
      // Update nextPlayers with fresh data
      const nextPlayersNew = currentDeckPlayerIds.map(id => queue.find(p => p.id === id)).filter(Boolean);
      if (nextPlayersNew.length === 0) {
        deckLoaded = false;
      }
    }
  }

  // If deck is now completely empty, show "need more" message
  if (currentDeckPlayerIds.length === 0 || nextPlayers.length === 0) {
    deckLoaded = false;
    currentDeckPlayerIds = [];
    currentDeckTeamSplit = null;
    const msg = queue.length < perGame
      ? `Need ${perGame - queue.length} more player(s) in queue.`
      : `Need ${need} more player(s) to check in.`;

    const loadBtn = button("Show Next Deck", null, "", "Show the next group of players");
    loadBtn.disabled = checkedIn.length < perGame;

    deckEl.replaceChildren(
      el("div", { className: "court deck-card" },
        el("div", { className: "court-head" }, el("h3", { textContent: "Up next deck" })),
        el("p", { className: "deck-empty", textContent: msg }),
        el("div", { className: "court-actions", style: "margin-top: 0.6rem;" }, loadBtn)
      )
    );
    return;
  }

  // Split preview teams using LOCKED split
  function previewSplit(players) {
    const [a, b, c, d] = players;
    const opts = [[[a,b],[c,d]], [[a,c],[b,d]], [[a,d],[b,c]]];
    const valid = opts.filter(([t1, t2]) => {
      const ok = (team) => team.every(p =>
        !p.partner_id || team.some(q => q.id === p.partner_id)
      );
      return ok(t1) && ok(t2);
    });
    const chosen = valid.length ? valid[Math.floor(Math.random() * valid.length)] : opts[0];
    return chosen;
  }
  
  // Use locked split if available, otherwise compute it
  let team1, team2;
  if (currentDeckTeamSplit) {
    team1 = currentDeckTeamSplit[0].map(id => nextPlayers.find(p => p && p.id === id)).filter(Boolean);
    team2 = currentDeckTeamSplit[1].map(id => nextPlayers.find(p => p && p.id === id)).filter(Boolean);
  } else {
    // Filter out any undefined players before splitting
    const validPlayers = nextPlayers.filter(Boolean);
    if (validPlayers.length === perGame) {
      [team1, team2] = previewSplit(validPlayers);
    } else {
      team1 = [];
      team2 = [];
    }
  }

  const reshuffleBtn = button("Reshuffle", () => {
    const deck = pickDeckGroup(checkedIn, perGame);
    currentDeckPlayerIds = deck.map(p => p.id);
    
    // Recompute team split for new deck
    function computeTeamSplit(players) {
      const [a, b, c, d] = players;
      const opts = [[[a,b],[c,d]], [[a,c],[b,d]], [[a,d],[b,c]]];
      const valid = opts.filter(([t1, t2]) => {
        const ok = (team) => team.every(p =>
          !p.partner_id || team.some(q => q.id === p.partner_id)
        );
        return ok(t1) && ok(t2);
      });
      const chosen = valid.length ? valid[Math.floor(Math.random() * valid.length)] : opts[0];
      return chosen.map(team => team.map(p => p.id));
    }
    
    currentDeckTeamSplit = computeTeamSplit(deck);
    publishCurrentDeck();  // Send updated deck to server
    render(lastState);
  }, "quiet", "Choose a different group");

  const hideBtn = button("Hide Deck", () => { 
    deckLoaded = false; 
    currentDeckTeamSplit = null;
    render(lastState); 
  }, "quiet", "Hide current deck");

  const actionsContainer = el("div", { className: "court-actions", style: "margin-top: 0.6rem; display: flex; gap: 0.35rem; flex-wrap: wrap;" }, reshuffleBtn, hideBtn);

  courts.forEach((c, index) => {
    if (c.length === 0) {
      const assignBtn = button(`C${index + 1}`, async () => {
        await run(`/api/courts/${index}/start`, { player_ids: currentDeckPlayerIds });
        deckLoaded = false;
        currentDeckPlayerIds = [];
        currentDeckTeamSplit = null;
        deckSentJustNow = true;  // Prevent auto-gen on next render
      }, "", `Send deck to Court ${index + 1}`);
      actionsContainer.append(assignBtn);
    }
  });

  deckEl.replaceChildren(
    el("div", { className: "court deck-card" },
      el("div", { className: "court-head" }, el("h3", { textContent: "Up next deck" })),
      el("div", { className: "team-labels" }, el("span", { textContent: "Team 1" }), el("span", { textContent: "Team 2" })),
      el("ul", {},
        ...team1.map(p => el("li", {}, el("span", { textContent: p.name }), record(p))),
        ...team2.map(p => el("li", {}, el("span", { textContent: p.name }), record(p)))
      ),
      actionsContainer
    )
  );
}

function checkinButton(p) {
  const on = p.checked_in;
  const btn = button(
    on ? "✓ In" : "Check In",
    () => run(`/api/checkin/${p.id}`),
    on ? "checkin-on" : "checkin-off",
    on ? `${p.name} is checked in` : `Check in ${p.name}`
  );
  return btn;
}

function render(data) {
  lastState = data;
  if (courtDragging) return;   // keep the DOM stable while a name is being dragged
  const { queue, courts, breaks, per_game, max_courts, checked_in_count,
          queue_join_times, server_time } = data;

  // If deck was just sent, don't auto-generate a new one
  const skipDeckRegeneration = deckSentJustNow;
  deckSentJustNow = false;  // Reset flag

  // Compute client↔server time offset once per render
  const serverOffset = server_time ? (Date.now() / 1000) - server_time : 0;

  // If deck was just sent to court, don't auto-show a new one
  if (skipDeckRegeneration && !deckLoaded) {
    // Just show "Click to reveal" button, don't auto-generate
    const checkedIn = queue.filter(p => p.checked_in);
    const loadBtn = button("Show Next Deck", () => {
      const deck = pickDeckGroup(checkedIn, per_game, queue_join_times, serverOffset);
      currentDeckPlayerIds = deck.map(p => p.id);
      
      function computeTeamSplit(players) {
        const [a, b, c, d] = players;
        const opts = [[[a,b],[c,d]], [[a,c],[b,d]], [[a,d],[b,c]]];
        const valid = opts.filter(([t1, t2]) => {
          const ok = (team) => team.every(p =>
            !p.partner_id || team.some(q => q.id === p.partner_id)
          );
          return ok(t1) && ok(t2);
        });
        const chosen = valid.length ? valid[Math.floor(Math.random() * valid.length)] : opts[0];
        return chosen.map(team => team.map(p => p.id));
      }
      
      currentDeckTeamSplit = computeTeamSplit(currentDeckPlayerIds.map(id => queue.find(p => p.id === id)));
      deckLoaded = true;
      render(lastState);
    }, "", "Show the next group of players");
    loadBtn.disabled = checkedIn.length < per_game;

    $("#deck").replaceChildren(
      el("div", { className: "court deck-card" },
        el("div", { className: "court-head" }, el("h3", { textContent: "Up next deck" })),
        el("p", { className: "deck-empty", textContent: "Click below to reveal a random group." }),
        el("div", { className: "court-actions", style: "margin-top: 0.6rem;" }, loadBtn)
      )
    );
    return;
  }

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
  renderDeck(queue, per_game, courts);

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

  $("#queue").replaceChildren(
    ...(sortedQueue.length
      ? sortedQueue.map((p, i) => {
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
            el("span", { className: "spot", textContent: i + 1 }),
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
      : [el("li", { className: "empty", textContent: "No one waiting. Join to get in line." })]));

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
$("#add-court").onclick = () => run("/api/courts");
$("#remove-court").onclick = () => run("/api/courts/remove");
$("#reset-btn").onclick = () => {
  if (confirm("Reset everything? This clears all players, courts, and records.")) {
    deckLoaded = false;
    currentDeckPlayerIds = [];
    currentDeckTeamSplit = null;
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

function renderDeck(queue, perGame, courts) {
  renderDeckInner(queue, perGame, courts);
}