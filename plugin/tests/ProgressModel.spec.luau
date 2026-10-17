local H = require("./harness")
local PM = H.require(H.src.UI.ProgressModel)

local describe, it, eq, truthy = H.describe, H.it, H.eq, H.truthy

local function step(id, target, status, extra)
	local s = { id = id, display = id, target = target, status = status }
	for k, v in pairs(extra or {}) do
		s[k] = v
	end
	return s
end

describe("ProgressModel", function()
	it("tags targets and summarizes per target", function()
		eq(PM.tag("client#2"), "P2")
		eq(PM.tag("server"), "SERVER")
		local sum = PM.summarize({
			step("a", "server", "passed"),
			step("b", "client#1", "failed"),
			step("c", "client#1", "pending"),
			step("d", "server", "running"),
		})
		eq(#sum, 2)
		eq(sum[1].tag, "SERVER")
		eq(sum[1].done, 1)
		eq(sum[1].total, 2)
		eq(sum[2].tag, "P1")
		eq(sum[2].failed, true)
	end)

	it("rolls statuses up", function()
		eq(PM.rollup({ step("a", "server", "passed"), step("b", "server", "passed") }), "passed")
		eq(PM.rollup({ step("a", "server", "passed"), step("b", "server", "running") }), "running")
		eq(PM.rollup({ step("a", "server", "running"), step("b", "server", "failed") }), "failed")
		eq(PM.rollup({ step("a", "server", "passed"), step("b", "server", "pending") }), "pending")
		eq(PM.rollup({ step("a", "server", "skipped"), step("b", "server", "cancelled") }), "skipped")
	end)

	it("main window: no grouping", function()
		local rows = PM.group({ step("a", "server", "passed"), step("b", "client#1", "passed") }, nil)
		eq(#rows, 2)
		eq(rows[1].kind, "step")
		eq(rows[2].kind, "step")
	end)

	it("client window: consecutive other-target steps fold into groups; mine stay as rows", function()
		local steps = {
			step("s0", "client#1", "passed"),
			step("s1", "server", "passed"),
			step("s2", "client#1", "passed"), -- P1 (other)
			step("s3", "server", "passed"),
			step("s4", "client#2", "running"), -- mine
			step("s5", "server", "pending"),
			step("s6", "client#2", "pending"), -- mine
			step("s7", "client#1", "pending"),
			step("s8", "client#1", "pending"),
		}
		local rows = PM.group(steps, "client#2")
		eq(#rows, 5)
		eq(rows[1].kind, "group")
		eq(#rows[1].steps, 4)
		eq(rows[1].first, 1)
		eq(rows[1].last, 4)
		eq(table.concat(rows[1].targets, ","), "P1,SERVER")
		eq(rows[1].status, "passed")
		eq(rows[1].done, 4)
		eq(rows[1].autoExpand, false)
		eq(rows[2].kind, "step")
		eq(rows[2].index, 5)
		eq(rows[3].kind, "group")
		eq(#rows[3].steps, 1)
		eq(rows[3].status, "pending")
		eq(rows[4].kind, "step")
		eq(rows[5].kind, "group")
		eq(#rows[5].steps, 2)
		eq(rows[5].key, "8")
	end)

	it("auto-expands the group with the running step, or the first failed one", function()
		local rows = PM.group({
			step("s0", "server", "passed"),
			step("s1", "server", "running"),
			step("s2", "client#2", "pending"),
			step("s3", "server", "pending"),
		}, "client#2")
		eq(rows[1].autoExpand, true)
		eq(rows[1].current.id, "s1")
		eq(rows[1].status, "running")
		eq(rows[3].autoExpand, false)
		truthy(PM.groupLabel(rows[1]):find("2 steps on SERVER · running: s1", 1, true), PM.groupLabel(rows[1]))
		eq(PM.groupLabel(rows[3]), "1 step on SERVER")

		local failed = PM.group({
			step("a", "server", "failed", { reason = "boom" }),
			step("b", "server", "skipped"),
			step("c", "client#1", "skipped"),
			step("d", "server", "skipped"),
		}, "client#1")
		eq(failed[1].autoExpand, true)
		eq(failed[1].status, "failed")
		eq(failed[1].current.id, "a")
		eq(failed[3].autoExpand, false)
		eq(failed[3].status, "skipped")
		eq(PM.groupLabel(failed[1]), "2 steps on SERVER · failed: a")
	end)

	it("formats elapsed time and budget", function()
		eq(PM.fmtSeconds(2400), "2.4s")
		eq(PM.fmtSeconds(65000), "1m 05s")
		eq(PM.elapsedText(2400, 10000), "2.4s / 10.0s")
		eq(PM.elapsedText(300, nil), "0.3s")
		local f, warn = PM.budget(5000, 10000)
		eq(f, 0.5)
		eq(warn, false)
		local f2, warn2 = PM.budget(9000, 10000)
		eq(f2, 0.9)
		eq(warn2, true)
		local f3 = PM.budget(1, nil)
		eq(f3, 0)
	end)
end)
