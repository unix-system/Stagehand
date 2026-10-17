--!strict
--[[
	ProgressModel — the pure part of the "Stagehand Progress" widget (no Instances, no Roblox
	datatypes), so it can be unit-tested under Lune. Progress.luau renders what this computes.

	A progress snapshot (docs/protocol.md `progress` command) lists every step with target
	("server" | "client#N" | "edit" | "daemon") and status. In a client window ("mine" = that window's
	"client#N") the steps that run elsewhere are folded into groups so the player's own steps stand out.
]]

local ProgressModel = {}

export type Step = {
	id: string,
	display: string?,
	target: string?,
	status: string?,
	reason: string?,
	verb: string?,
	elapsedMs: number?,
	durationMs: number?,
	timeoutMs: number?,
	soft: boolean?,
}

export type StepRow = { kind: "step", index: number, step: Step }
export type GroupRow = {
	kind: "group",
	key: string, -- stable per run: index of the first step in the group
	steps: { Step },
	first: number,
	last: number,
	targets: { string }, -- distinct tags in order of appearance ("SERVER", "P2")
	status: string, -- rolled up: failed | running | passed | pending | skipped
	done: number,
	current: Step?, -- the running (or first failed) step inside the group, for the summary line
	autoExpand: boolean,
}
export type Row = StepRow | GroupRow

local TERMINAL = { passed = true, failed = true, skipped = true, cancelled = true }

--- "client#2" → "P2", "server" → "SERVER".
function ProgressModel.tag(target: string): string
	local n = target:match("^client#(%d+)$")
	return if n then "P" .. n else string.upper(target)
end

--- Per-target counts in first-seen order: { { tag, done, total, failed } }.
function ProgressModel.summarize(steps: { Step }): { any }
	local order, by = {}, {}
	for _, s in ipairs(steps) do
		local t = ProgressModel.tag(tostring(s.target))
		local e = by[t]
		if not e then
			e = { tag = t, done = 0, total = 0, failed = false }
			by[t] = e
			table.insert(order, e)
		end
		e.total += 1
		local st = tostring(s.status)
		if st ~= "pending" and st ~= "running" then
			e.done += 1
		end
		if st == "failed" then
			e.failed = true
		end
	end
	return order
end

--- Roll a list of statuses up into one: failed > running > pending (any left) > passed/skipped.
function ProgressModel.rollup(steps: { Step }): string
	local anyRunning, anyPending, anyFailed, allSkipped = false, false, false, true
	for _, s in ipairs(steps) do
		local st = tostring(s.status)
		if st == "failed" then
			anyFailed = true
		elseif st == "running" then
			anyRunning = true
		elseif st == "pending" then
			anyPending = true
		end
		if st ~= "skipped" and st ~= "cancelled" then
			allSkipped = false
		end
	end
	if anyFailed then
		return "failed"
	elseif anyRunning then
		return "running"
	elseif anyPending then
		return "pending"
	elseif allSkipped and #steps > 0 then
		return "skipped"
	end
	return "passed"
end

--- Rows for a window. With `mine` (a client window) every maximal run of consecutive steps whose
--- target is not `mine` becomes one group row; without it (the main window) every step is a row.
--- The group holding the running step, or the first failed one, is marked for auto-expansion.
function ProgressModel.group(steps: { Step }, mine: string?): { Row }
	local rows: { Row } = {}
	if mine == nil then
		for i, s in ipairs(steps) do
			table.insert(rows, { kind = "step", index = i, step = s })
		end
		return rows
	end
	local open: GroupRow? = nil
	local function close()
		if open then
			local g = open :: GroupRow
			g.status = ProgressModel.rollup(g.steps)
			table.insert(rows, g)
			open = nil
		end
	end
	local firstFailedSeen = false
	for i, s in ipairs(steps) do
		if s.target == mine then
			close()
			table.insert(rows, { kind = "step", index = i, step = s })
		else
			if not open then
				open = {
					kind = "group",
					key = tostring(i),
					steps = {},
					first = i,
					last = i,
					targets = {},
					status = "pending",
					done = 0,
					current = nil,
					autoExpand = false,
				}
			end
			local g = open :: GroupRow
			table.insert(g.steps, s)
			g.last = i
			local t = ProgressModel.tag(tostring(s.target))
			if not table.find(g.targets, t) then
				table.insert(g.targets, t)
			end
			local st = tostring(s.status)
			if TERMINAL[st] then
				g.done += 1
			end
			if st == "running" and g.current == nil then
				g.current = s
				g.autoExpand = true
			elseif st == "failed" and not firstFailedSeen then
				firstFailedSeen = true
				g.current = g.current or s
				g.autoExpand = true
			end
		end
	end
	close()
	return rows
end

--- "7 steps on SERVER, P2 · running: wait player.onTeam as p2"
function ProgressModel.groupLabel(g: GroupRow): string
	local n = #g.steps
	local head = string.format("%d step%s on %s", n, if n == 1 then "" else "s", table.concat(g.targets, ", "))
	if g.current then
		local what = if tostring(g.current.status) == "failed" then "failed" else "running"
		return head .. " · " .. what .. ": " .. tostring(g.current.display or g.current.id)
	end
	if g.done == n and n > 0 then
		return head .. " · done"
	end
	return head
end

--- "2.4s" / "0.3s" / "1m 05s"
function ProgressModel.fmtSeconds(ms: number): string
	local s = math.max(0, ms) / 1000
	if s >= 60 then
		return string.format("%dm %02ds", math.floor(s / 60), math.floor(s % 60))
	end
	return string.format("%.1fs", s)
end

--- Live elapsed text for a running step: "2.4s / 10s" (budget only when known).
function ProgressModel.elapsedText(elapsedMs: number, timeoutMs: number?): string
	local e = ProgressModel.fmtSeconds(elapsedMs)
	if timeoutMs and timeoutMs > 0 then
		return e .. " / " .. ProgressModel.fmtSeconds(timeoutMs)
	end
	return e
end

--- Fraction of the budget used (0..1); `warn` when past 75 %.
function ProgressModel.budget(elapsedMs: number, timeoutMs: number?): (number, boolean)
	if not timeoutMs or timeoutMs <= 0 then
		return 0, false
	end
	local f = math.clamp(elapsedMs / timeoutMs, 0, 1)
	return f, f >= 0.75
end

return ProgressModel
