import json
import random
import time
import re
import requests
from bs4 import BeautifulSoup
from itertools import combinations, count
from threading import Lock
from flask import Flask, jsonify, render_template, render_template_string, request, Response

app = Flask(__name__)

PLAYERS_PER_GAME = 4
MATCH_WINDOW = 12
MAX_COURTS = 12

lock = Lock()
next_id = count(1)
queue = []  # [{"id": 1, "name": "Sam"}]
on_break = []  # [{"id": 2, "name": "Ana"}]
courts = [[], []]  # each court: [team1_a, team1_b, team2_a, team2_b] or []
court_start_times = {}  # court_index -> unix timestamp (float) when game started
queue_join_times  = {}  # player_id   -> unix timestamp (float) when joined queue
just_finished_players = {}  # player_id -> timestamp when they just finished a game
results = {}  # name_lower -> {"w": 0, "l": 0}
game_history = []  # List of completed games with details: [{"court": n, "team1": [...], "team2": [...], "winner": 1|2, "score1": s1, "score2": s2}, ...]
together = {}  # (name_a, name_b) -> games in the same game
partners = {}  # (name_a, name_b) -> games as teammates
locked_with = {}  # player_id -> partner player_id
sse_clients = []  # list of queues to broadcast standings updates


def get_standings():
    """Build sorted standings from results dict, with avatars from current players."""
    # Build avatar lookup from everyone currently tracked
    avatar_lookup = {}
    everyone = list(queue) + list(on_break) + [p for c in courts for p in c]
    for p in everyone:
        av = p.get("avatar")
        if av:
            avatar_lookup[p["name"].lower()] = av

    sorted_s = sorted(
        [{"name": name.capitalize(), "w": stats["w"], "l": stats["l"],
          "pts": stats.get("pts", 0)} for name, stats in results.items()],
        key=lambda x: (x["pts"], x["w"], -x["l"]),
        reverse=True
    )
    for p in sorted_s:
        p["avatar"] = avatar_lookup.get(p["name"].lower())
    return sorted_s


def broadcast_standings():
    """Send standings update to all connected SSE clients."""
    standings = get_standings()
    now = time.time()
    msg = f"data: {json.dumps({'standings': standings, 'server_time': now})}\n\n"
    dead_clients = []
    for i, q in enumerate(sse_clients):
        try:
            q.put(msg)
        except:
            dead_clients.append(i)
    # Clean up dead connections
    for i in reversed(dead_clients):
        sse_clients.pop(i)


def tally(p):
    r = results.get(p["name"].lower(), {"w": 0, "l": 0, "pts": 0})
    return {"id": p["id"], "name": p["name"], "w": r["w"], "l": r["l"],
            "pts": r.get("pts", 0),
            "partner_id": locked_with.get(p["id"]),
            "checked_in": p.get("checked_in", False),
            "avatar": p.get("avatar", None)}


def state():
    checked_in_count = sum(1 for p in queue if p.get("checked_in", False))
    now = time.time()
    return {
        "queue": [tally(p) for p in queue],
        "courts": [[tally(p) for p in c] for c in courts],
        "breaks": [tally(p) for p in on_break],
        "per_game": PLAYERS_PER_GAME,
        "max_courts": MAX_COURTS,
        "checked_in_count": checked_in_count,
        "court_start_times": {str(k): v for k, v in court_start_times.items()},
        "queue_join_times":  {str(k): v for k, v in queue_join_times.items()},
        "server_time": now,
    }


def name_taken(name):
    everyone = queue + on_break + [p for c in courts for p in c]
    return any(p["name"].lower() == name.lower() for p in everyone)


def unlock(player_id):
    other = locked_with.pop(player_id, None)
    if other is not None:
        locked_with.pop(other, None)


def pair(a, b):
    return tuple(sorted((a["name"].lower(), b["name"].lower())))


def make_units():
    checked = [p for p in queue if p.get("checked_in", False)]
    pos = {p["id"]: i for i, p in enumerate(checked)}
    seen, units = set(), []
    for i, p in enumerate(checked):
        if p["id"] in seen:
            continue
        unit = [i]
        other = locked_with.get(p["id"])
        if other in pos:
            unit.append(pos[other])
            seen.add(other)
        seen.add(p["id"])
        units.append(unit)
    return units, checked


def pick_group():
    units, checked = make_units()
    if sum(len(u) for u in checked) < PLAYERS_PER_GAME:
        return None, None

    # Sort checked players by wait time (oldest/longest first)
    # But deprioritize players who just finished a game
    now = time.time()
    checked_with_wait = []
    for i, p in enumerate(checked):
        wait_time = now - queue_join_times.get(p["id"], now)
        just_finished = just_finished_players.get(p["id"], 0)
        # If just finished (within last 2 seconds), put at bottom of priority
        if now - just_finished < 2:
            wait_time = -float('inf')  # Lowest priority
        checked_with_wait.append((wait_time, i, p))
    
    checked_with_wait.sort(reverse=True, key=lambda x: x[0])  # longest wait first
    
    # Get priority positions
    priority_pos = {p["id"]: i for i, (_, _, p) in enumerate(checked_with_wait)}
    
    # Build units with their minimum priority (earliest player in the unit)
    units_by_priority = []
    for unit_indices in units:
        # Get players in this unit
        unit_players = [checked[i] for i in unit_indices]
        # Find minimum priority (highest in the queue) in this unit
        min_priority = min(priority_pos.get(p["id"], float('inf')) for p in unit_players)
        units_by_priority.append((min_priority, unit_indices))
    
    # Sort units by priority
    units_by_priority.sort(key=lambda x: x[0])
    
    # Select units greedily: pick units starting from highest priority (longest wait)
    selected_indices = []
    for priority, unit_indices in units_by_priority:
        if len(selected_indices) + len(unit_indices) <= PLAYERS_PER_GAME:
            selected_indices.extend(unit_indices)
            if len(selected_indices) == PLAYERS_PER_GAME:
                # Remove from just_finished tracking once they're picked
                for idx in selected_indices:
                    just_finished_players.pop(checked[idx]["id"], None)
                return selected_indices, checked
    
    # If we couldn't get 4 players from non-just-finished players,
    # allow just-finished players if absolutely needed
    if len(selected_indices) < PLAYERS_PER_GAME:
        # Try to fill remaining spots with just-finished players if needed
        for priority, unit_indices in units_by_priority:
            if any(checked[idx]["id"] in just_finished_players for idx in unit_indices):
                if len(selected_indices) + len(unit_indices) <= PLAYERS_PER_GAME:
                    selected_indices.extend(unit_indices)
                    if len(selected_indices) == PLAYERS_PER_GAME:
                        for idx in selected_indices:
                            just_finished_players.pop(checked[idx]["id"], None)
                        return selected_indices, checked
    
    return None, None


def split_teams(group):
    a, b, c, d = group
    options = [((a, b), (c, d)), ((a, c), (b, d)), ((a, d), (b, c))]

    # Keep only options where locked partners are on the SAME team (never opponents)
    def partners_same_team(opt):
        t1, t2 = opt
        for player in t1:
            partner_id = locked_with.get(player["id"])
            if partner_id is not None:
                # Partner must also be in t1, not t2
                if not any(p["id"] == partner_id for p in t1):
                    return False
        for player in t2:
            partner_id = locked_with.get(player["id"])
            if partner_id is not None:
                if not any(p["id"] == partner_id for p in t2):
                    return False
        return True

    valid = [o for o in options if partners_same_team(o)]
    # Fallback: if somehow no valid option (shouldn't happen), use all options
    if not valid:
        valid = options

    random.shuffle(valid)
    t1, t2 = min(valid, key=lambda o: sum(partners.get(pair(*t), 0) for t in o))
    if random.random() < 0.5:
        t1, t2 = t2, t1
    return [*t1, *t2]


def record_game(teams):
    for a, b in combinations(teams, 2):
        together[pair(a, b)] = together.get(pair(a, b), 0) + 1
    for x, y in ((teams[0], teams[1]), (teams[2], teams[3])):
        partners[pair(x, y)] = partners.get(pair(x, y), 0) + 1


def error(message, code=409):
    return jsonify(error=message), code


# GLASSMORPHISM MAIN INDEX TEMPLATE
INDEX_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Pickle Flow Manager</title>
    <style>
        :root {
            --ink: #ffffff;
            --muted: rgba(255, 255, 255, 0.68);
            --accent: #7dd3fc;
            --accent-2: #c4b5fd;
            --glass: rgba(255, 255, 255, 0.10);
            --glass-soft: rgba(255, 255, 255, 0.06);
            --glass-border: rgba(255, 255, 255, 0.24);
            --glass-highlight: rgba(255, 255, 255, 0.45);
            --shadow: 0 8px 32px rgba(10, 8, 40, 0.35);
        }
        * { box-sizing: border-box; }
        html {
            min-height: 100%;
            background:
                radial-gradient(60rem 40rem at 10% 0%, #6d28d9 0%, transparent 60%),
                radial-gradient(50rem 40rem at 100% 10%, #0ea5e9 0%, transparent 60%),
                radial-gradient(50rem 45rem at 80% 100%, #db2777 0%, transparent 60%),
                radial-gradient(45rem 40rem at 0% 100%, #4338ca 0%, transparent 60%),
                #1e1b4b;
            background-attachment: fixed;
        }
        body::before, body::after {
            content: ""; position: fixed; z-index: -1; border-radius: 50%;
            filter: blur(60px); pointer-events: none;
        }
        body::before {
            width: 26rem; height: 26rem; top: 12%; left: -6rem; opacity: 0.75;
            background: radial-gradient(circle at 30% 30%, #f0abfc, #a855f7 55%, transparent 72%);
            animation: drift1 16s ease-in-out infinite alternate;
        }
        body::after {
            width: 30rem; height: 30rem; bottom: 4%; right: -8rem; opacity: 0.7;
            background: radial-gradient(circle at 70% 30%, #67e8f9, #3b82f6 55%, transparent 72%);
            animation: drift2 20s ease-in-out infinite alternate;
        }
        @keyframes drift1 { from { transform: translate(0,0) scale(1); } to { transform: translate(90px,70px) scale(1.12); } }
        @keyframes drift2 { from { transform: translate(0,0) scale(1); } to { transform: translate(-110px,-80px) scale(1.15); } }
        @media (prefers-reduced-motion: reduce) { body::before, body::after { animation: none; } button { transition: none; } }

        /* Frosted glass surface */
        .glass-card, .court-box, .players-sidebar {
            background: linear-gradient(135deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.05) 60%), var(--glass);
            border: 1px solid var(--glass-border);
            border-radius: 24px;
            box-shadow: var(--shadow), inset 0 1px 0 var(--glass-highlight), inset 0 -1px 0 rgba(255,255,255,0.06);
            -webkit-backdrop-filter: blur(22px) saturate(170%);
            backdrop-filter: blur(22px) saturate(170%);
        }
        @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
            .glass-card, .court-box, .players-sidebar { background: rgba(49, 46, 129, 0.85); }
        }
        /* Glass buttons */
        button {
            font: inherit; font-weight: 600; cursor: pointer; color: #fff;
            padding: 12px 24px; border-radius: 14px;
            background: linear-gradient(180deg, rgba(255,255,255,0.35), rgba(255,255,255,0.08)), rgba(99,102,241,0.55);
            border: 1px solid rgba(255,255,255,0.4);
            box-shadow: 0 4px 16px rgba(79,70,229,0.35), inset 0 1px 0 rgba(255,255,255,0.5);
            -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
            transition: transform 0.15s ease, box-shadow 0.2s ease, background 0.2s ease;
        }
        button:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(79,70,229,0.5), inset 0 1px 0 rgba(255,255,255,0.6); }
        button:active { transform: translateY(1px); }
        :focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

        body {
            font-family: 'Inter', 'Segoe UI', system-ui, Tahoma, sans-serif;
            margin: 0; padding: 20px; min-height: 100vh;
            color: var(--ink); position: relative; overflow-x: hidden;
        }
        h1 {
            text-align: center; font-size: 2.6rem; font-weight: 800; letter-spacing: -0.02em;
            margin: 0 0 25px; color: #fff; text-shadow: 0 2px 18px rgba(125, 211, 252, 0.6);
        }
        h3, h4 { margin-top: 0; color: #fff; }
        .container { max-width: 1100px; margin: 0 auto; }

        .glass-card { padding: 25px; margin-bottom: 25px; }
        .form-group { display: flex; gap: 12px; margin-bottom: 15px; }
        .field-label { display: block; margin-bottom: 8px; font-size: 0.9rem; color: var(--muted); }

        /* Frosted inputs */
        input[type="text"], textarea {
            flex: 1; min-width: 0; padding: 12px 16px; border-radius: 14px;
            font: inherit; color: #fff; outline: none;
            background: rgba(255,255,255,0.12);
            border: 1px solid var(--glass-border);
            box-shadow: inset 0 2px 6px rgba(10,8,40,0.18);
            -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
            transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
        }
        input[type="text"]::placeholder, textarea::placeholder { color: rgba(255,255,255,0.55); }
        input[type="text"]:focus, textarea:focus {
            background: rgba(255,255,255,0.18); border-color: var(--accent);
            box-shadow: inset 0 2px 6px rgba(10,8,40,0.18), 0 0 0 3px rgba(125,211,252,0.45);
        }
        textarea { resize: vertical; height: 75px; }

        .btn-secondary {
            background: rgba(255,255,255,0.10);
            border: 1px solid var(--glass-border);
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.25);
        }
        .btn-secondary:hover { background: rgba(255,255,255,0.20); box-shadow: 0 6px 18px rgba(10,8,40,0.25), inset 0 1px 0 rgba(255,255,255,0.4); }
        .btn-danger { padding: 5px 12px; font-size: 0.85rem; background: linear-gradient(180deg, rgba(255,255,255,0.3), rgba(255,255,255,0.05)), rgba(244,63,94,0.55); box-shadow: 0 3px 12px rgba(244,63,94,0.35), inset 0 1px 0 rgba(255,255,255,0.45); }
        .btn-win1 { flex: 1; background: linear-gradient(180deg, rgba(255,255,255,0.3), rgba(255,255,255,0.05)), rgba(16,185,129,0.6); box-shadow: 0 4px 14px rgba(16,185,129,0.35), inset 0 1px 0 rgba(255,255,255,0.45); }
        .btn-win2 { flex: 1; background: linear-gradient(180deg, rgba(255,255,255,0.3), rgba(255,255,255,0.05)), rgba(14,165,233,0.6); box-shadow: 0 4px 14px rgba(14,165,233,0.35), inset 0 1px 0 rgba(255,255,255,0.45); }

        .actions-bar { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 25px; justify-content: center; }
        .main-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 25px; }
        .main-grid > div { min-width: 0; }
        .queue-list, .courts-grid { display: flex; flex-direction: column; gap: 12px; }

        /* Inset glass well for the waiting list */
        .recessed-box {
            background: rgba(10, 8, 40, 0.28);
            border: 1px solid rgba(255,255,255,0.16);
            border-radius: 18px; padding: 12px;
            box-shadow: inset 0 4px 12px rgba(10,8,40,0.35), 0 1px 0 rgba(255,255,255,0.1);
        }
        .player-chip {
            display: flex; justify-content: space-between; align-items: center; gap: 8px;
            padding: 10px 14px; border-radius: 14px; font-weight: 600;
            background: rgba(255,255,255,0.10);
            border: 1px solid rgba(255,255,255,0.18);
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.22);
        }
        .empty { color: var(--muted); padding: 10px; }

        .team-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
        .team-box {
            padding: 10px; border-radius: 14px; text-align: center;
            background: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.18);
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.22);
        }
        .team-label { color: var(--accent); font-weight: 700; font-size: 0.9rem; }
        .team-players { margin-top: 6px; font-size: 1.05rem; font-weight: 600; color: #fff; overflow-wrap: anywhere; }
        .win-row { display: flex; gap: 10px; margin-top: 12px; }

        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: rgba(255,255,255,0.06); border-radius: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.3); border-radius: 4px; }

        @media (max-width: 768px) {
            .main-grid { grid-template-columns: 1fr; }
            h1 { font-size: 2rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎾 Pickle Flow Manager</h1>
        
        <!-- Add Players Glass Card -->
        <div class="glass-card">
            <h3>Add Players</h3>
            <form id="join-form" onsubmit="joinPlayer(event)">
                <div class="form-group">
                    <input type="text" id="player-name" placeholder="Enter player name..." maxlength="24" autocomplete="off">
                    <button type="submit">Join Queue</button>
                </div>
            </form>
            
            <form id="bulk-form" onsubmit="bulkJoin(event)" style="margin-top: 15px;">
                <label class="field-label" for="bulk-names">Bulk Add Names (separated by comma or new line):</label>
                <div class="form-group" style="align-items: flex-start;">
                    <textarea id="bulk-names" placeholder="Player 1, Player 2, Player 3..."></textarea>
                    <button type="submit" class="btn-secondary" style="height: 100%;">Bulk Add</button>
                </div>
            </form>
        </div>

        <!-- Controls Bar -->
        <div class="actions-bar">
            <button onclick="addCourt()" class="btn-secondary">➕ Add Court</button>
            <button onclick="removeCourt()" class="btn-secondary">➖ Remove Court</button>
            <button onclick="reshuffle()" class="btn-secondary">🔀 Reshuffle Queue</button>
            <button onclick="window.open('/tv', '_blank')">📺 Open TV View</button>
            <button onclick="window.open('/api/report-page', '_blank')" class="btn-secondary">📊 Export Report</button>
        </div>

        <!-- Courts & Waiting Area Layout -->
        <div class="main-grid">
            <div>
                <h3>Courts</h3>
                <div id="courts-container" class="courts-grid"></div>
            </div>
            <div>
                <h3>Waiting Queue (<span id="queue-count">0</span>)</h3>
                <div class="recessed-box">
                    <div id="queue-container" class="queue-list" style="max-height: 460px; overflow-y: auto; padding-right: 4px;"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function fetchState() {
            try {
                const res = await fetch('/api/state');
                const data = await res.json();
                updateUI(data);
            } catch (err) {
                console.error(err);
            }
        }

        async function joinPlayer(e) {
            e.preventDefault();
            const input = document.getElementById('player-name');
            const name = input.value.trim();
            if (!name) return;
            const res = await fetch('/api/join', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name})
            });
            if (res.ok) {
                input.value = '';
                fetchState();
            } else {
                const err = await res.json();
                alert(err.error);
            }
        }

        async function bulkJoin(e) {
            e.preventDefault();
            const textarea = document.getElementById('bulk-names');
            const names = textarea.value.trim();
            if (!names) return;
            const res = await fetch('/api/bulk-join', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({names})
            });
            if (res.ok) {
                textarea.value = '';
                fetchState();
            } else {
                const err = await res.json();
                alert(err.error);
            }
        }

        async function leaveQueue(id) {
            await fetch('/api/leave/' + id, {method: 'POST'});
            fetchState();
        }

        async function addCourt() {
            await fetch('/api/courts', {method: 'POST'});
            fetchState();
        }

        async function removeCourt() {
            await fetch('/api/courts/remove', {method: 'POST'});
            fetchState();
        }

        async function reshuffle() {
            await fetch('/api/deck/reshuffle', {method: 'POST'});
            fetchState();
        }

        async function startCourt(n) {
            const res = await fetch('/api/courts/' + n + '/start', {method: 'POST'});
            if (!res.ok) {
                const err = await res.json();
                alert(err.error);
            }
            fetchState();
        }

        async function finishCourt(n, winner) {
            await fetch('/api/courts/' + n + '/finish', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({winner})
            });
            fetchState();
        }

        function updateUI(data) {
            document.getElementById('queue-count').innerText = data.queue.length;
            const qEl = document.getElementById('queue-container');
            qEl.innerHTML = data.queue.length === 0 ? '<i class="empty">No one waiting.</i>' : '';
            data.queue.forEach(p => {
                qEl.innerHTML += `<div class="player-chip"><span>${p.name}</span> <button class="btn-danger" onclick="leaveQueue(${p.id})" aria-label="Remove from queue">X</button></div>`;
            });

            const cEl = document.getElementById('courts-container');
            cEl.innerHTML = '';
            data.courts.forEach((c, idx) => {
                if (!c || c.length === 0) {
                    cEl.innerHTML += `
                        <div class="glass-card" style="margin-bottom:0;">
                            <h4>Court ${idx + 1} (Free)</h4>
                            <button onclick="startCourt(${idx})" style="margin-top:10px; width:100%;">Start Next Game</button>
                        </div>
                    `;
                } else {
                    cEl.innerHTML += `
                        <div class="glass-card" style="margin-bottom:0;">
                            <h4>Court ${idx + 1} (In Play)</h4>
                            <div class="team-grid">
                                <div class="team-box">
                                    <div class="team-label">TEAM 1</div>
                                    <div class="team-players">${c[0].name}<br>${c[1].name}</div>
                                </div>
                                <div class="team-box">
                                    <div class="team-label">TEAM 2</div>
                                    <div class="team-players">${c[2].name}<br>${c[3].name}</div>
                                </div>
                            </div>
                            <div class="win-row">
                                <button class="btn-win1" onclick="finishCourt(${idx}, 1)">Team 1 Won</button>
                                <button class="btn-win2" onclick="finishCourt(${idx}, 2)">Team 2 Won</button>
                            </div>
                        </div>
                    `;
                }
            });
        }

        setInterval(fetchState, 3000);
        fetchState();
    </script>
</body>
</html>
"""


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/state")
def get_state():
    with lock:
        return jsonify(state())


@app.get("/api/standings")
def get_standings_json():
    """Returns sorted standings with name, w, l, pts.
    Also attaches avatar URL from any player currently in queue/break/court."""
    with lock:
        return jsonify(get_standings())


@app.get("/api/standings-stream")
def standings_stream():
    """Server-Sent Events stream for real-time standings updates."""
    from queue import Queue
    q = Queue()
    sse_clients.append(q)
    
    def generate():
        try:
            # Send current standings immediately
            standings = get_standings()
            yield f"data: {json.dumps(standings)}\n\n"
            # Then wait for updates
            while True:
                msg = q.get(timeout=30)  # 30s timeout to detect dead clients
                yield msg
        except:
            pass
        finally:
            if q in sse_clients:
                sse_clients.remove(q)
    
    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache",
                             "X-Accel-Buffering": "no"})


@app.post("/api/join")
def join():
    name = (request.get_json(silent=True) or {}).get("name", "").strip()[:24]
    if not name:
        return error("Enter a name to join the queue.", 400)
    with lock:
        if name_taken(name):
            return error(f"{name} is already in the queue, on break, or on a court.")
        p = {"id": next(next_id), "name": name}
        queue.append(p)
        # Timer starts only when they check in, not when they join
        return jsonify(state())


@app.post("/api/bulk-join")
def bulk_join():
    data = request.get_json(silent=True) or {}
    raw_text = data.get("names", "")
    names = [n.strip()[:24] for n in re.split(r'[\n,]+', raw_text) if n.strip()]
    
    if not names:
        return error("Walang nakitang pangalan na idaragdag.", 400)
        
    added_count = 0
    with lock:
        for name in names:
            if not name_taken(name):
                p = {"id": next(next_id), "name": name}
                queue.append(p)
                # Timer starts on check-in, not on join
                added_count += 1
        res = state()
        res["added_count"] = added_count
        return jsonify(res)


@app.post("/api/leave/<int:player_id>")
def leave(player_id):
    with lock:
        unlock(player_id)
        queue[:] = [p for p in queue if p["id"] != player_id]
        on_break[:] = [p for p in on_break if p["id"] != player_id]
        queue_join_times.pop(player_id, None)
        return jsonify(state())


@app.post("/api/partner")
def lock_partner():
    data = request.get_json(silent=True) or {}
    a, b = data.get("a"), data.get("b")
    with lock:
        waiting = {p["id"]: p for p in queue}
        if a == b or a not in waiting or b not in waiting:
            return error("Both players must be waiting in the queue.")
        if a in locked_with or b in locked_with:
            return error("One of them already has a locked partner.")
        locked_with[a], locked_with[b] = b, a
        return jsonify(state())


@app.post("/api/unpartner/<int:player_id>")
def unpartner(player_id):
    with lock:
        unlock(player_id)
        return jsonify(state())


@app.post("/api/break/<int:player_id>")
def take_break(player_id):
    with lock:
        if not any(p["id"] == player_id for p in queue):
            return error("Only players in the queue can take a break.")
        ids = {player_id, locked_with.get(player_id)}
        going = [p for p in queue if p["id"] in ids]
        for p in going:
            queue.remove(p)
            on_break.append({"id": p["id"], "name": p["name"],
                             "checked_in": p.get("checked_in", False),
                             "avatar": p.get("avatar")})
            # Clear timer when on break
            queue_join_times.pop(p["id"], None)
        return jsonify(state())


@app.post("/api/resume/<int:player_id>")
def resume(player_id):
    with lock:
        if not any(p["id"] == player_id for p in on_break):
            return error("That player is not on break.")
        ids = {player_id, locked_with.get(player_id)}
        for p in [p for p in on_break if p["id"] in ids]:
            on_break.remove(p)
            queue.append({"id": p["id"], "name": p["name"],
                          "checked_in": p.get("checked_in", False),
                          "avatar": p.get("avatar")})
            # Restart timer if they were checked in before break
            if p.get("checked_in", False):
                queue_join_times[p["id"]] = time.time()
        return jsonify(state())


@app.post("/api/courts")
def add_court():
    with lock:
        if len(courts) >= MAX_COURTS:
            return error(f"The limit is {MAX_COURTS} courts.")
        courts.append([])
        return jsonify(state())


@app.post("/api/courts/remove")
def remove_court():
    with lock:
        if len(courts) <= 1:
            return error("Keep at least one court.")
        if courts[-1]:
            return error(f"Court {len(courts)} has a game in progress.")
        courts.pop()
        return jsonify(state())


@app.post("/api/courts/<int:n>/start")
def start(n):
    data = request.get_json(silent=True) or {}
    player_ids = data.get("player_ids")
    
    with lock:
        if not 0 <= n < len(courts) or courts[n]:
            return error("That court is not free.")
        if len(queue) < PLAYERS_PER_GAME:
            return error(f"Need {PLAYERS_PER_GAME} players in the queue.")

        if player_ids:
            group = []
            indices = []
            for pid in player_ids:
                found_idx = next((i for i, p in enumerate(queue) if p["id"] == pid), None)
                if found_idx is not None:
                    indices.append(found_idx)
                    group.append(queue[found_idx])

            if len(group) < PLAYERS_PER_GAME:
                return error("Some players are no longer in the queue.")

            # Enforce check-in requirement
            not_checked = [p["name"] for p in group if not p.get("checked_in", False)]
            if not_checked:
                return error(f"{', '.join(not_checked)} must be checked in before playing.")

            for i in sorted(indices, reverse=True):
                del queue[i]

            # Always use split_teams so locked partners end up on the same team
            courts[n] = split_teams(group)
        else:
            idx, checked = pick_group()
            if idx is None:
                return error("Need at least 4 checked-in players to start a game.")
            group = [checked[i] for i in idx]
            # Remove from the main queue by id
            picked_ids = {p["id"] for p in group}
            queue[:] = [p for p in queue if p["id"] not in picked_ids]
            courts[n] = split_teams(group)
                
        record_game(courts[n])
        court_start_times[n] = time.time()  # record start time
        return jsonify(state())


@app.post("/api/courts/<int:n>/finish")
def finish(n):
    data    = request.get_json(silent=True) or {}
    winner  = data.get("winner")
    score1  = data.get("score1")   # winning team score (int)
    score2  = data.get("score2")   # losing team score (int)
    with lock:
        if not 0 <= n < len(courts) or not courts[n]:
            return error("No game on that court.")
        if winner in (1, 2):
            won, lost = (courts[n][:2], courts[n][2:]) if winner == 1 else (courts[n][2:], courts[n][:2])
            # Point differential: winner score - loser score (0 if not provided)
            try:
                pts_for     = int(score1) if score1 is not None else 0
                pts_against = int(score2) if score2 is not None else 0
            except (ValueError, TypeError):
                pts_for, pts_against = 0, 0
            diff_won  =  pts_for - pts_against   # positive for winners
            diff_lost =  pts_against - pts_for   # negative for losers
            for p in won:
                r = results.setdefault(p["name"].lower(), {"w": 0, "l": 0, "pts": 0})
                r["w"]   += 1
                r["pts"] += diff_won
            for p in lost:
                r = results.setdefault(p["name"].lower(), {"w": 0, "l": 0, "pts": 0})
                r["l"]   += 1
                r["pts"] += diff_lost
            
            # Store game in history
            game_history.append({
                "court": n + 1,
                "team1": [{"name": p["name"]} for p in (courts[n][:2] if winner == 1 else courts[n][2:])],
                "team2": [{"name": p["name"]} for p in (courts[n][2:] if winner == 1 else courts[n][:2])],
                "winner": winner,
                "score1": pts_for,
                "score2": pts_against
            })
        
        for p in courts[n]:
            queue.append({"id": p["id"], "name": p["name"],
                          "checked_in": True, "avatar": p.get("avatar")})
            # Mark when they finished so they won't be picked again immediately
            queue_join_times[p["id"]] = time.time()  # Put them at the back of queue
            just_finished_players[p["id"]] = time.time()  # Mark as just finished
        courts[n] = []
        court_start_times.pop(n, None)  # clear timer
        broadcast_standings()  # push update to all SSE clients
        return jsonify(state())


@app.post("/api/courts/<int:n>/swap")
def swap_players(n):
    """Swap two players between teams on a court."""
    data = request.get_json(silent=True) or {}
    a_id = data.get("a")
    b_id = data.get("b")
    
    with lock:
        if not 0 <= n < len(courts) or not courts[n]:
            return error("No game on that court.", 400)
        if len(courts[n]) != PLAYERS_PER_GAME:
            return error("Court must have exactly 4 players.", 400)
        
        # Find both players on the court
        a_idx = next((i for i, p in enumerate(courts[n]) if p["id"] == a_id), None)
        b_idx = next((i for i, p in enumerate(courts[n]) if p["id"] == b_id), None)
        
        if a_idx is None or b_idx is None:
            return error("One or both players not found on court.", 404)
        
        # Determine which teams they're on (0-1 for team 1, 2-3 for team 2)
        a_team = 0 if a_idx < 2 else 1
        b_team = 0 if b_idx < 2 else 1
        
        # Only allow swap if they're on different teams
        if a_team == b_team:
            return error("Players must be on different teams to swap.", 400)
        
        # Swap the players in the courts array
        courts[n][a_idx], courts[n][b_idx] = courts[n][b_idx], courts[n][a_idx]
        
        return jsonify(state())


@app.post("/api/deck/reshuffle")
def reshuffle_deck():
    with lock:
        checked_count = sum(1 for p in queue if p.get("checked_in", False))
        if checked_count < PLAYERS_PER_GAME:
            return error(f"Need at least {PLAYERS_PER_GAME} checked-in players.")
        random.shuffle(queue)
        return jsonify(state())


@app.post("/api/checkin/<int:player_id>")
def toggle_checkin(player_id):
    with lock:
        p = next((p for p in queue if p["id"] == player_id), None)
        if p is None:
            return error("Player not found in queue.", 404)
        # Toggle checked-in status
        was_checked = p.get("checked_in", False)
        p["checked_in"] = not was_checked
        # Record join time when they check in
        if not was_checked and player_id not in queue_join_times:
            queue_join_times[player_id] = time.time()
        return jsonify(state())


@app.post("/api/reclub-import")
def reclub_import():
    data = request.get_json(silent=True) or {}
    event_url = data.get("url", "").strip()
    if not event_url or "reclub.co" not in event_url:
        return error("Maglagay ng valid na ReClub URL (hal. https://reclub.co/m/5T6SPF)", 400)
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
        resp = requests.get(event_url, headers=headers, timeout=10)
        if resp.status_code != 200:
            return error("Hindi ma-access ang ReClub link. Pakisuri ang link.", 400)

        soup = BeautifulSoup(resp.text, 'html.parser')

        # ── Step 1: build avatar map via usersMap in __NUXT_DATA__ ──
        avatar_map = {}   # name.lower() -> avatar_url
        nuxt = None
        users_map_obj = None

        def resolve(idx, _depth=0):
            """Follow an integer index reference in the nuxt flat array."""
            if nuxt is None or _depth > 10:
                return None
            v = nuxt[idx]
            if isinstance(v, int) and v != idx:
                return resolve(v, _depth + 1)
            return v

        nuxt_match = re.search(
            r'<script[^>]+id=["\']__NUXT_DATA__["\'][^>]*>\s*(\[.+?\])\s*</script>',
            resp.text, re.DOTALL
        )
        if nuxt_match:
            try:
                nuxt = json.loads(nuxt_match.group(1))

                # Find the usersMap dict: keys are numeric strings (user IDs),
                # values are integer indices pointing to user-objects
                for item in nuxt:
                    if (isinstance(item, dict)
                            and len(item) >= 1
                            and all(isinstance(k, str) and k.isdigit() for k in item)):
                        users_map_obj = item
                        break

                if users_map_obj:
                    for user_id_str, user_obj_idx in users_map_obj.items():
                        user_obj = nuxt[user_obj_idx] if isinstance(user_obj_idx, int) else None
                        if not isinstance(user_obj, dict):
                            continue
                        name_idx = user_obj.get("name")
                        img_idx  = user_obj.get("imageUrl")
                        if name_idx is None or img_idx is None:
                            continue
                        name_val = resolve(name_idx)
                        img_val  = resolve(img_idx)
                        if (isinstance(name_val, str) and isinstance(img_val, str)
                                and "assets.reclub.co" in img_val):
                            avatar_map[name_val.lower()] = img_val

            except Exception:
                pass  # best-effort

        # ── Step 2: extract confirmed players only (exclude host) ───────────────
        extracted_names = []

        # First: identify the host's name from NUXT so we can exclude them
        host_names = set()
        if nuxt:
            try:
                for item in nuxt:
                    if not isinstance(item, dict):
                        continue
                    if item.get("isHost") is not True:
                        continue
                    # Host found — get their name
                    ref_id = item.get("referenceId")
                    ref_resolved = resolve(ref_id) if isinstance(ref_id, int) else ref_id
                    if users_map_obj and str(ref_resolved) in users_map_obj:
                        user_obj_idx = users_map_obj[str(ref_resolved)]
                        user_obj = nuxt[user_obj_idx] if isinstance(user_obj_idx, int) else None
                        if isinstance(user_obj, dict):
                            name_val = resolve(user_obj.get("name"))
                            if isinstance(name_val, str) and name_val.strip():
                                host_names.add(name_val.strip().lower())
            except Exception:
                pass

        # Primary method: HTML extraction with host exclusion
        # Extract confirmed player names from the HTML "truncate" class elements
        # These are the most reliable source matching what ReClub displays
        conf_match = re.search(
            r'<p[^>]*>\s*Confirmed\s*[·•]\s*\d+\s*</p>|Confirmed\s*<span[^>]*>\s*[·•]\s*\d+',
            resp.text, re.IGNORECASE
        )
        # Fallback: find "Confirmed" text node followed by a grid
        if not conf_match:
            conf_match = re.search(r'Confirmed\s*[·•]\s*\d+', resp.text, re.IGNORECASE)

        # Find where the Confirmed grid ends (Waitlist section or Open app button)
        end_match = re.search(
            r'Waitlist\s*[·•]\s*\d+|class=["\'][^"\']*MeetStatus|Open app',
            resp.text, re.IGNORECASE
        )

        section_html = resp.text[
            conf_match.start() if conf_match else 0 :
            end_match.start() if end_match else len(resp.text)
        ]

        trunc_pattern = re.compile(
            r'<p\s[^>]*class=["\'][^"\']*truncate[^"\']*["\'][^>]*>(.*?)</p>',
            re.IGNORECASE | re.DOTALL
        )
        seen_lower = set()
        for m in trunc_pattern.finditer(section_html):
            text = re.sub(r'<[^>]+>', '', m.group(1)).strip()[:24]
            if (text
                    and len(text) >= 1
                    and text.lower() not in seen_lower
                    and text.lower() not in host_names):   # Explicitly skip host
                seen_lower.add(text.lower())
                extracted_names.append(text)

        # Fallback A: anchor /players/@ links (misses guests without accounts)
        if not extracted_names:
            seen_hrefs = set()
            for a_tag in soup.find_all("a", href=re.compile(r"/players/@")):
                href = a_tag.get("href", "")
                if href in seen_hrefs:
                    continue
                seen_hrefs.add(href)
                name_text = a_tag.get_text(" ", strip=True)[:24]
                if (name_text
                        and name_text not in extracted_names
                        and name_text.lower() not in host_names):
                    extracted_names.append(name_text)

        # Fallback B: NUXT confirmed (status=1) participants, non-host only
        if not extracted_names and nuxt and users_map_obj:
            for item in nuxt:
                if not isinstance(item, dict):
                    continue
                if "referenceId" not in item or "status" not in item:
                    continue
                # Skip if marked as host
                if item.get("isHost") is True:
                    continue
                status_val = item.get("status")
                status_resolved = resolve(status_val) if isinstance(status_val, int) else status_val
                if status_resolved != 1:
                    continue
                ref_id = item.get("referenceId")
                ref_resolved = resolve(ref_id) if isinstance(ref_id, int) else ref_id
                if str(ref_resolved) in users_map_obj:
                    user_obj_idx = users_map_obj[str(ref_resolved)]
                    user_obj = nuxt[user_obj_idx] if isinstance(user_obj_idx, int) else None
                    if isinstance(user_obj, dict):
                        name_val = resolve(user_obj.get("name"))
                        if isinstance(name_val, str) and name_val.strip():
                            clean = name_val.strip()[:24]
                            # Skip if this is the host
                            if clean.lower() not in host_names and clean not in extracted_names:
                                extracted_names.append(clean)

        # Ultimate fallback: displayName from raw JSON
        if not extracted_names:
            for raw in re.findall(r'"displayName"\s*:\s*"([^"]+)"', resp.text):
                try:
                    raw = json.loads('"' + raw + '"')
                except ValueError:
                    pass
                clean = raw.strip()[:24]
                # Skip if this is the host
                if clean and clean.lower() not in host_names and clean not in extracted_names:
                    extracted_names.append(clean)

        if not extracted_names:
            return error("Walang nakitang confirmed players sa binigay na ReClub link.", 404)

        # ── Step 3: add players with their avatars ──
        added_count = 0
        with lock:
            for name in extracted_names:
                if not name_taken(name):
                    player = {"id": next(next_id), "name": name}
                    av = avatar_map.get(name.lower())
                    if av:
                        player["avatar"] = av
                    queue.append(player)
                    # Timer starts on check-in
                    added_count += 1
            res_state = state()
            res_state["added_count"] = added_count
        return jsonify(res_state)
    except Exception as e:
        return error(f"Nagkaroon ng error sa pag-fetch sa ReClub: {str(e)}", 500)


REPORT_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Game Records Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; color: #333; background: #fff; }
        h1 { text-align: center; color: #111; margin-bottom: 5px; }
        p.subtitle { text-align: center; color: #666; margin-top: 0; margin-bottom: 30px; }
        h2 { color: #111; margin-top: 40px; margin-bottom: 15px; border-bottom: 2px solid #ddd; padding-bottom: 8px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; margin-bottom: 20px; }
        th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
        th { background-color: #f4f4f4; color: #111; font-weight: bold; }
        tr:nth-child(even) { background-color: #fafafa; }
        .no-print { margin-bottom: 25px; text-align: center; }
        .btn { background: #111; color: #fff; padding: 10px 20px; border: none; cursor: pointer; font-size: 16px; border-radius: 4px; font-weight: bold; }
        .btn:hover { background: #333; }
        .game-record { margin-bottom: 30px; border: 1px solid #ddd; border-radius: 8px; padding: 15px; background-color: #fafafa; }
        .court-header { font-weight: bold; font-size: 16px; color: #111; margin-bottom: 10px; }
        .team-box { display: inline-block; width: 45%; vertical-align: top; }
        .team-box-winner { background-color: #e8f5e9; padding: 10px; border-radius: 4px; }
        .team-box-loser { background-color: #ffebee; padding: 10px; border-radius: 4px; }
        .team-label { font-weight: bold; margin-bottom: 8px; }
        .player-name { margin: 4px 0; padding-left: 10px; }
        .score { text-align: center; font-size: 18px; font-weight: bold; color: #333; padding: 0 10px; display: inline-block; vertical-align: top; width: 8%; }
        .vs-text { text-align: center; display: inline-block; width: 2%; vertical-align: middle; font-weight: bold; color: #999; }
        @media print {
            .no-print { display: none; }
            body { margin: 10px; }
        }
    </style>
</head>
<body>
    <div class="no-print">
        <button class="btn" onclick="window.print()">📥 Save as PDF / Print</button>
        <button class="btn" onclick="window.close()" style="background: #666; margin-left: 10px;">Close</button>
    </div>
    <h1>Game Records Report</h1>
    <p class="subtitle">Summary of wins and losses for all players</p>
    
    <!-- Overall Statistics Section -->
    <h2>📊 Overall Standings</h2>
    <table>
        <thead>
            <tr>
                <th>Rank</th>
                <th>Player Name</th>
                <th>Wins</th>
                <th>Losses</th>
                <th>Total Games</th>
                <th>Win Rate</th>
                <th>Points</th>
            </tr>
        </thead>
        <tbody>
            {% if results %}
                {% for p in results %}
                <tr>
                    <td>{{ loop.index }}</td>
                    <td>{{ p.name }}</td>
                    <td>{{ p.w }}</td>
                    <td>{{ p.l }}</td>
                    <td>{{ p.w + p.l }}</td>
                    <td>{{ "%.1f" | format((p.w / (p.w + p.l) * 100) if (p.w + p.l) > 0 else 0) }}%</td>
                    <td>{{ p.pts }}</td>
                </tr>
                {% endfor %}
            {% else %}
                <tr>
                    <td colspan="7" style="text-align: center; color: #777;">No games recorded yet.</td>
                </tr>
            {% endif %}
        </tbody>
    </table>
    
    <!-- Game History Section -->
    {% if games %}
    <h2>🏆 Game History</h2>
    {% for game in games | reverse %}
    <div class="game-record">
        <div class="court-header">Court {{ game.court }}</div>
        <div style="margin-top: 10px;">
            <div class="team-box {% if game.winner == 1 %}team-box-winner{% else %}team-box-loser{% endif %}">
                <div class="team-label">Team 1 {% if game.winner == 1 %}✓ WON{% else %}LOST{% endif %}</div>
                {% for player in game.team1 %}
                <div class="player-name">{{ player.name }}</div>
                {% endfor %}
            </div>
            <div class="score">{{ game.score1 }}</div>
            <div class="vs-text">VS</div>
            <div class="score">{{ game.score2 }}</div>
            <div class="team-box {% if game.winner == 2 %}team-box-winner{% else %}team-box-loser{% endif %}">
                <div class="team-label">Team 2 {% if game.winner == 2 %}✓ WON{% else %}LOST{% endif %}</div>
                {% for player in game.team2 %}
                <div class="player-name">{{ player.name }}</div>
                {% endfor %}
            </div>
        </div>
    </div>
    {% endfor %}
    {% else %}
    <h2>🏆 Game History</h2>
    <p style="text-align: center; color: #777; padding: 20px;">No games recorded yet.</p>
    {% endif %}
</body>
</html>
"""

@app.get("/api/report-page")
def report_page():
    with lock:
        sorted_results = sorted(
            [{"name": name.capitalize(), "w": stats["w"], "l": stats["l"],
              "pts": stats.get("pts", 0)} for name, stats in results.items()],
            key=lambda x: (x["pts"], x["w"], -x["l"]),
            reverse=True
        )
        game_history_copy = list(game_history)  # Make a copy to avoid lock issues
    return render_template_string(REPORT_TEMPLATE, results=sorted_results, games=game_history_copy)


# TV DISPLAY TEMPLATE (GLASSMORPHISM & STABLE SCROLL LAYOUT)
TV_DISPLAY_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Pickle Flow - Live TV Display</title>
    <style>
        :root {
            --ink: #ffffff;
            --muted: rgba(255, 255, 255, 0.68);
            --accent: #7dd3fc;
            --accent-2: #c4b5fd;
            --glass: rgba(255, 255, 255, 0.10);
            --glass-soft: rgba(255, 255, 255, 0.06);
            --glass-border: rgba(255, 255, 255, 0.24);
            --glass-highlight: rgba(255, 255, 255, 0.45);
            --shadow: 0 8px 32px rgba(10, 8, 40, 0.35);
        }
        * { box-sizing: border-box; }
        html {
            min-height: 100%;
            background:
                radial-gradient(60rem 40rem at 10% 0%, #6d28d9 0%, transparent 60%),
                radial-gradient(50rem 40rem at 100% 10%, #0ea5e9 0%, transparent 60%),
                radial-gradient(50rem 45rem at 80% 100%, #db2777 0%, transparent 60%),
                radial-gradient(45rem 40rem at 0% 100%, #4338ca 0%, transparent 60%),
                #1e1b4b;
            background-attachment: fixed;
        }
        body::before, body::after {
            content: ""; position: fixed; z-index: -1; border-radius: 50%;
            filter: blur(60px); pointer-events: none;
        }
        body::before {
            width: 26rem; height: 26rem; top: 12%; left: -6rem; opacity: 0.75;
            background: radial-gradient(circle at 30% 30%, #f0abfc, #a855f7 55%, transparent 72%);
            animation: drift1 16s ease-in-out infinite alternate;
        }
        body::after {
            width: 30rem; height: 30rem; bottom: 4%; right: -8rem; opacity: 0.7;
            background: radial-gradient(circle at 70% 30%, #67e8f9, #3b82f6 55%, transparent 72%);
            animation: drift2 20s ease-in-out infinite alternate;
        }
        @keyframes drift1 { from { transform: translate(0,0) scale(1); } to { transform: translate(90px,70px) scale(1.12); } }
        @keyframes drift2 { from { transform: translate(0,0) scale(1); } to { transform: translate(-110px,-80px) scale(1.15); } }
        @media (prefers-reduced-motion: reduce) { body::before, body::after { animation: none; } button { transition: none; } }

        /* Frosted glass surface */
        .glass-card, .court-box, .players-sidebar {
            background: linear-gradient(135deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.05) 60%), var(--glass);
            border: 1px solid var(--glass-border);
            border-radius: 24px;
            box-shadow: var(--shadow), inset 0 1px 0 var(--glass-highlight), inset 0 -1px 0 rgba(255,255,255,0.06);
            -webkit-backdrop-filter: blur(22px) saturate(170%);
            backdrop-filter: blur(22px) saturate(170%);
        }
        @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
            .glass-card, .court-box, .players-sidebar { background: rgba(49, 46, 129, 0.85); }
        }
        /* Glass buttons */
        button {
            font: inherit; font-weight: 600; cursor: pointer; color: #fff;
            padding: 12px 24px; border-radius: 14px;
            background: linear-gradient(180deg, rgba(255,255,255,0.35), rgba(255,255,255,0.08)), rgba(99,102,241,0.55);
            border: 1px solid rgba(255,255,255,0.4);
            box-shadow: 0 4px 16px rgba(79,70,229,0.35), inset 0 1px 0 rgba(255,255,255,0.5);
            -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
            transition: transform 0.15s ease, box-shadow 0.2s ease, background 0.2s ease;
        }
        button:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(79,70,229,0.5), inset 0 1px 0 rgba(255,255,255,0.6); }
        button:active { transform: translateY(1px); }
        :focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

        body {
            font-family: 'Inter', 'Segoe UI', system-ui, Tahoma, sans-serif;
            margin: 0; padding: 20px; color: var(--ink);
            height: 100vh; display: flex; flex-direction: column; overflow: hidden;
        }
        h1 { text-align: center; color: #fff; font-size: 2.2rem; margin: 0 0 5px 0; font-weight: 800; letter-spacing: -0.02em; text-shadow: 0 2px 18px rgba(125, 211, 252, 0.6); }
        p.subtitle { text-align: center; color: var(--muted); font-size: 1rem; margin: 0 0 20px 0; }

        .main-layout { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; flex: 1; min-height: 0; overflow: hidden; }
        .courts-grid { display: grid; gap: 15px; height: 100%; align-content: start; overflow-y: auto; padding-right: 5px; }
        .court-box { padding: 15px; display: flex; flex-direction: column; justify-content: space-between; border-radius: 22px; }
        .court-title { font-size: 1.3rem; font-weight: 700; color: #fff; border-bottom: 1px solid rgba(255,255,255,0.18); padding-bottom: 6px; margin-bottom: 12px; }

        .teams-container { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; flex: 1; align-items: stretch; }
        .team-box {
            background: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.18);
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.22);
            padding: 12px; border-radius: 16px; display: flex; flex-direction: column;
            justify-content: center; align-items: center; text-align: center;
        }
        .team-label { color: var(--accent); font-size: 1rem; font-weight: 700; margin-bottom: 8px; }
        .team-players { color: #fff; font-size: 1.15rem; font-weight: 700; word-break: break-word; line-height: 1.4; }
        .free-court { color: var(--muted); font-style: italic; text-align: center; font-size: 1.2rem; margin: auto; }

        .players-sidebar { padding: 15px; display: flex; flex-direction: column; height: 100%; overflow: hidden; border-radius: 22px; }
        .sidebar-title { font-size: 1.4rem; font-weight: 700; color: #fff; border-bottom: 1px solid rgba(255,255,255,0.18); padding-bottom: 8px; margin: 0 0 10px 0; text-align: center; letter-spacing: 1px; }

        .table-scroll {
            flex: 1; overflow-y: auto; padding-right: 4px; border-radius: 16px;
            background: rgba(10, 8, 40, 0.28); border: 1px solid rgba(255,255,255,0.16);
            box-shadow: inset 0 4px 12px rgba(10,8,40,0.35);
        }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 1rem; }
        th {
            position: sticky; top: 0; z-index: 2; color: var(--accent);
            background: rgba(49, 46, 129, 0.75);
            -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
        }
        .rank-1 { color: #fde047; font-weight: bold; text-shadow: 0 0 10px rgba(253,224,71,0.5); }
        .rank-2 { color: #e2e8f0; font-weight: bold; }
        .rank-3 { color: #fdba74; font-weight: bold; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: rgba(255,255,255,0.06); border-radius: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.3); border-radius: 4px; }
    </style>
</head>
<body>
    <h1>🎾 Pickle Flow Live Display</h1>
    <p class="subtitle">Live Court Status & Player Standings</p>
    
    <div class="main-layout">
        <div class="courts-grid" id="courts-container"></div>
        
        <div class="players-sidebar">
            <h2 class="sidebar-title">PLAYERS STANDINGS</h2>
            <div class="table-scroll">
                <table>
                    <thead>
                        <tr>
                            <th>Rank</th>
                            <th>Name</th>
                            <th>W</th>
                            <th>L</th>
                            <th>Win%</th>
                        </tr>
                    </thead>
                    <tbody id="standings-tbody">
                        {% if results %}
                            {% for p in results %}
                            <tr>
                                <td class="{% if loop.index == 1 %}rank-1{% elif loop.index == 2 %}rank-2{% elif loop.index == 3 %}rank-3{% endif %}">
                                    {% if loop.index == 1 %}🥇 1st{% elif loop.index == 2 %}🥈 2nd{% elif loop.index == 3 %}🥉 3rd{% else %}#{{ loop.index }}{% endif %}
                                </td>
                                <td style="font-weight: bold; color: #fff;">{{ p.name }}</td>
                                <td>{{ p.w }}</td>
                                <td>{{ p.l }}</td>
                                <td>{{ "%.0f" | format((p.w / (p.w + p.l) * 100) if (p.w + p.l) > 0 else 0) }}%</td>
                            </tr>
                            {% endfor %}
                        {% else %}
                            <tr><td colspan="5" style="text-align: center; color: rgba(255,255,255,0.68);">No games recorded yet.</td></tr>
                        {% endif %}
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        async function fetchTVData() {
            try {
                const res = await fetch('/api/state');
                const data = await res.json();
                
                const courtsEl = document.getElementById('courts-container');
                courtsEl.innerHTML = '';
                
                const totalCourts = data.courts.length;
                
                if (totalCourts === 1) {
                    courtsEl.style.gridTemplateColumns = '1fr';
                    courtsEl.style.gridTemplateRows = '1fr';
                } else if (totalCourts === 2) {
                    courtsEl.style.gridTemplateColumns = '1fr';
                    courtsEl.style.gridTemplateRows = 'repeat(2, 1fr)';
                } else {
                    courtsEl.style.gridTemplateColumns = '1fr 1fr';
                    courtsEl.style.gridTemplateRows = 'repeat(' + Math.ceil(totalCourts / 2) + ', 1fr)';
                }
                
                data.courts.forEach((c, idx) => {
                    const courtDiv = document.createElement('div');
                    courtDiv.className = 'court-box';
                    
                    if (!c || c.length === 0) {
                        courtDiv.innerHTML = `
                            <div class="court-title">COURT ${idx + 1}</div>
                            <div class="free-court">Available / Free</div>
                        `;
                    } else {
                        const t1 = `${c[0].name}<br>${c[1].name}`;
                        const t2 = `${c[2].name}<br>${c[3].name}`;
                        courtDiv.innerHTML = `
                            <div class="court-title">COURT ${idx + 1} (In Play)</div>
                            <div class="teams-container">
                                <div class="team-box">
                                    <div class="team-label">TEAM 1</div>
                                    <div class="team-players">${t1}</div>
                                </div>
                                <div class="team-box">
                                    <div class="team-label">TEAM 2</div>
                                    <div class="team-players">${t2}</div>
                                </div>
                            </div>
                        `;
                    }
                    courtsEl.appendChild(courtDiv);
                });
            } catch (err) {
                console.error(err);
            }
        }

        setInterval(() => {
            fetchTVData();
            location.reload(); 
        }, 5000);
        
        fetchTVData();
    </script>
</body>
</html>
"""

@app.get("/tv")
def tv_display():
    with lock:
        sorted_results = sorted(
            [{"name": name.capitalize(), "w": stats["w"], "l": stats["l"],
              "pts": stats.get("pts", 0)} for name, stats in results.items()],
            key=lambda x: (x["pts"], x["w"], -x["l"]),
            reverse=True
        )
    return render_template("tv.html", results=sorted_results)


@app.post("/api/reset")
def reset_state():
    global next_id
    with lock:
        next_id = count(1)
        queue[:] = []
        on_break[:] = []
        courts[:] = [[], []]
        court_start_times.clear()
        queue_join_times.clear()
        just_finished_players.clear()
        results.clear()
        game_history.clear()
        together.clear()
        partners.clear()
        locked_with.clear()
        return jsonify(state())


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)