local H = require("./harness")
local Motion = H.require(H.src.Motion)

local describe, it, eq, truthy = H.describe, H.it, H.eq, H.truthy

local function near(a: number, b: number, eps: number?): boolean
	return math.abs(a - b) <= (eps or 1e-6)
end

-- Signed distance of p from the chord a→b (positive on one side, negative on the other).
local function side(a, b, p): number
	local dx, dy = b.x - a.x, b.y - a.y
	return ((p.x - a.x) * dy - (p.y - a.y) * dx) / math.sqrt(dx * dx + dy * dy)
end

describe("Motion.path", function()
	local A, B = { x = 100, y = 100 }, { x = 500, y = 100 }

	it("starts and ends exactly on the endpoints", function()
		local p = Motion.path(A, B)
		eq(p[1].x, 100)
		eq(p[1].y, 100)
		eq(p[#p].x, 500)
		eq(p[#p].y, 100)
		local q = Motion.path({ x = 3.5, y = -2 }, { x = 1200.25, y = 900 })
		eq(q[1].x, 3.5)
		eq(q[1].y, -2)
		eq(q[#q].x, 1200.25)
		eq(q[#q].y, 900)
	end)

	it("defaults the sample count to clamp(round(dist / 40), 6, 24)", function()
		eq(#Motion.path(A, B), 10) -- 400 px
		eq(#Motion.path(A, { x = 140, y = 100 }), 6) -- 40 px → 1, clamped
		eq(#Motion.path(A, A), 6) -- zero distance
		eq(#Motion.path(A, { x = 2100, y = 100 }), 24) -- 2000 px → 50, clamped
	end)

	it("honours an explicit sample count", function()
		eq(#Motion.path(A, B, { samples = 15 }), 15)
		eq(#Motion.path(A, B, { samples = 2 }), 2)
	end)

	it("bows away from the chord in the middle", function()
		local p = Motion.path(A, B, { samples = 11 })
		local mid = p[6]
		local off = math.abs(side(A, B, mid))
		truthy(off > 400 * 0.05, "mid point should be off the chord, was " .. off)
		truthy(off < 400 * 0.18, "bow should stay under 18% of the chord, was " .. off)
		-- every interior point lies on the same side
		local s = side(A, B, mid) > 0
		for i = 2, #p - 1 do
			eq(side(A, B, p[i]) > 0, s, "point " .. i .. " on the other side")
		end
	end)

	it("eases in and out", function()
		local p = Motion.path(A, B, { samples = 11, bow = 0 })
		local first = p[2].x - p[1].x
		local middle = p[7].x - p[6].x
		local last = p[#p].x - p[#p - 1].x
		truthy(first < middle, "slow start")
		truthy(last < middle, "slow finish")
		truthy(near(first, last, 1e-6), "symmetric easing")
	end)

	it("is deterministic for the same seed", function()
		local p = Motion.path(A, B, { seed = 42 })
		Motion.path(A, B) -- advance the internal counter in between
		local q = Motion.path(A, B, { seed = 42 })
		eq(#p, #q)
		for i = 1, #p do
			truthy(near(p[i].x, q[i].x) and near(p[i].y, q[i].y), "sample " .. i .. " differs")
		end
		truthy(math.abs(side(A, B, p[5])) > 1, "seeded path still bows")
	end)

	it("alternates the bow side across successive unseeded calls", function()
		local p = Motion.path(A, B, { samples = 9 })
		local q = Motion.path(A, B, { samples = 9 })
		local sp, sq = side(A, B, p[5]), side(A, B, q[5])
		truthy(math.abs(sp) > 1 and math.abs(sq) > 1, "both paths bow")
		truthy((sp > 0) ~= (sq > 0), "bow sides should alternate")
	end)

	it("uses an explicit bow magnitude", function()
		local p = Motion.path(A, B, { samples = 11, bow = 0 })
		for i = 1, #p do
			truthy(near(p[i].y, 100, 1e-9), "bow = 0 keeps the path on the chord")
		end
	end)
end)

describe("Motion.duration", function()
	it("clamps to 0.06 s for tiny moves", function()
		eq(Motion.duration(0), 0.06)
		eq(Motion.duration(10), 0.06)
	end)
	it("clamps to 0.22 s for huge moves", function()
		eq(Motion.duration(5000), 0.22)
		eq(Motion.duration(1e9), 0.22)
	end)
	it("is linear in between at 4000 px/s by default", function()
		truthy(near(Motion.duration(400), 0.1))
		truthy(near(Motion.duration(600), 0.15))
	end)
	it("honours a custom speed", function()
		truthy(near(Motion.duration(400, 2000), 0.2))
		eq(Motion.duration(400, 100), 0.22)
	end)
end)

describe("Motion.keyLabel", function()
	it("maps modifier and special keys to short labels", function()
		eq(Motion.keyLabel("W"), "W")
		eq(Motion.keyLabel("Space"), "Space")
		eq(Motion.keyLabel("LeftShift"), "Shift")
		eq(Motion.keyLabel("RightShift"), "Shift")
		eq(Motion.keyLabel("LeftControl"), "Ctrl")
		eq(Motion.keyLabel("Return"), "Enter")
		eq(Motion.keyLabel("Backspace"), "⌫")
		eq(Motion.keyLabel("F5"), "F5")
	end)
end)
