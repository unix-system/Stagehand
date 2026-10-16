local H = require("./harness")
local Setup = require("./setup")
local Conditions = H.require(H.src.Conditions)
local Signal = H.require(H.src.Signal)
local Env = H.require(H.src.Env)

local describe, it, eq, truthy = H.describe, H.it, H.eq, H.truthy

describe("Conditions.compare", function()
	Setup.dataModel()
	local roblox = require("@lune/roblox")
	it("eq / ne with numbers, strings, userdata", function()
		truthy(Conditions.compare("eq", 0, 0))
		truthy(Conditions.compare("eq", 0.1 + 0.2, 0.3))
		truthy(Conditions.compare("ne", 1, 2))
		truthy(Conditions.compare("eq", roblox.Vector3.new(1, 2, 3), { 1, 2, 3 }))
		truthy(Conditions.compare("eq", roblox.Color3.fromRGB(255, 0, 0), "#ff0000"))
		truthy(Conditions.compare("eq", roblox.Enum.Material.Neon, "Neon"))
		truthy(Conditions.compare("eq", roblox.Enum.Material.Neon, "Enum.Material.Neon"))
		truthy(not Conditions.compare("eq", nil, false))
		truthy(Conditions.compare("eq", { a = 1, b = { 2 } }, { a = 1, b = { 2 } }))
	end)
	it("ordering ops", function()
		truthy(Conditions.compare("gt", 3, 2))
		truthy(Conditions.compare("gte", 2, 2))
		truthy(Conditions.compare("lt", "1", 2))
		truthy(Conditions.compare("lte", 2, 2))
		truthy(not Conditions.compare("gt", nil, 2))
	end)
	it("contains / matches", function()
		truthy(Conditions.compare("contains", "hello world", "lo w"))
		truthy(Conditions.compare("contains", { "a", "b" }, "b"))
		truthy(not Conditions.compare("contains", { "a" }, "c"))
		truthy(Conditions.compare("matches", "Round 12", "^Round %d+$"))
		truthy(not Conditions.compare("matches", "x", "["))
	end)
end)

describe("Conditions.waitUntil", function()
	Setup.dataModel()
	local task = require("@lune/task")

	it("passes immediately when already true", function()
		local status = Conditions.waitUntil(function()
			return true, 1
		end, { timeout = 0 })
		eq(status, "passed")
	end)
	it("fails an instant check", function()
		local status, actual = Conditions.waitUntil(function()
			return false, { v = 1 }
		end, { timeout = 0 })
		eq(status, "failed")
		eq(actual.v, 1)
	end)
	it("wakes on a signal before the poll interval", function()
		local sig = Signal.new()
		local flag = false
		task.delay(0.05, function()
			flag = true
			sig:Fire()
		end)
		local t0 = Env.clock()
		local status = Conditions.waitUntil(function()
			return flag, nil
		end, {
			timeout = 2,
			pollInterval = 5,
			signals = function()
				return { sig }
			end,
		})
		eq(status, "passed")
		truthy(Env.clock() - t0 < 1, "woke via signal")
	end)
	it("polls without signals and times out", function()
		local n = 0
		local status = Conditions.waitUntil(function()
			n += 1
			return false, n
		end, { timeout = 0.1 })
		eq(status, "failed")
		truthy(n > 1, "polled more than once")
	end)
	it("stops on cancel", function()
		local cancel = Signal.new()
		local cancelled = false
		task.delay(0.05, function()
			cancelled = true
			cancel:Fire()
		end)
		local status = Conditions.waitUntil(function()
			return false, nil
		end, {
			timeout = 5,
			pollInterval = 5,
			cancelSignal = cancel,
			cancelled = function()
				return cancelled
			end,
		})
		eq(status, "cancelled")
	end)
	it("records errors from the check", function()
		local status, _, err = Conditions.waitUntil(function()
			error({ code = "RESOLVE_FAILED", message = "nope" })
		end, { timeout = 0 })
		eq(status, "failed")
		eq(err.code, "RESOLVE_FAILED")
	end)
end)
