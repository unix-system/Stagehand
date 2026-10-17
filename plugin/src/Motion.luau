--!strict
--[[
	Motion — pure helpers behind the input visualisation (docs/plugin.md "Input visualisation").

	No Roblox datatypes: points are plain `{ x = number, y = number }` tables so the module loads
	under Lune (plugin/tests/Motion.spec.luau) and the caller (Actions/Input) converts to Vector2.
]]

local Motion = {}

export type Point = { x: number, y: number }
export type PathOpts = { samples: number?, seed: number?, bow: number? }

local MIN_SAMPLES, MAX_SAMPLES = 6, 24
local PX_PER_SAMPLE = 40
local BOW_MIN, BOW_MAX = 0.03, 0.07 -- control-point offset as a fraction of the chord length
local DEFAULT_SPEED = 4000 -- px/s
local MIN_DURATION, MAX_DURATION = 0.06, 0.22

-- Successive un-seeded calls alternate the bow side so a series of moves does not all curve the
-- same way; `rngState` is a small LCG so un-seeded bows are still reproducible across runs.
local callCounter = 0
local rngState = 0x2545F491

local function lcg(state: number): (number, number)
	-- Numerical Recipes constants, kept within 2^32 via modulo (doubles hold the product exactly
	-- up to 2^53, so split the multiplication).
	local a, c, m = 1664525, 1013904223, 4294967296
	local next = (a * state + c) % m
	return next, next / m
end

local function smoothstep(t: number): number
	return t * t * (3 - 2 * t)
end

--- Cubic Bézier from `from` to `to`, bowed perpendicular to the chord, eased in and out.
--- First sample is exactly `from`, last exactly `to`.
function Motion.path(from: Point, to: Point, opts: PathOpts?): { Point }
	local o: PathOpts = opts or {}
	local dx, dy = to.x - from.x, to.y - from.y
	local dist = math.sqrt(dx * dx + dy * dy)

	local samples = o.samples or math.clamp(math.round(dist / PX_PER_SAMPLE), MIN_SAMPLES, MAX_SAMPLES)
	samples = math.max(2, math.floor(samples))

	if dist < 1 then
		local out = {}
		for i = 1, samples do
			out[i] = if i == samples then { x = to.x, y = to.y } else { x = from.x, y = from.y }
		end
		return out
	end

	-- Bow: magnitude in [BOW_MIN, BOW_MAX] of the chord; sign alternates per call (or from the seed).
	local u: number
	local sign: number
	if o.seed ~= nil then
		local s = math.floor(o.seed :: number) % 4294967296
		local _, r = lcg(s)
		u = r
		sign = if s % 2 == 0 then 1 else -1
	else
		callCounter += 1
		rngState, u = lcg(rngState)
		sign = if callCounter % 2 == 0 then 1 else -1
	end
	local bowFrac = if o.bow ~= nil then o.bow :: number else BOW_MIN + (BOW_MAX - BOW_MIN) * u
	local bow = sign * bowFrac * dist

	-- Unit perpendicular to the chord.
	local nx, ny = -dy / dist, dx / dist
	-- Control points at 1/3 and 2/3 along the chord, both offset to the same side.
	local c1x, c1y = from.x + dx / 3 + nx * bow, from.y + dy / 3 + ny * bow
	local c2x, c2y = from.x + 2 * dx / 3 + nx * bow, from.y + 2 * dy / 3 + ny * bow

	local out = table.create(samples)
	for i = 1, samples do
		local t = smoothstep((i - 1) / (samples - 1))
		local mt = 1 - t
		local a, b, c, d = mt * mt * mt, 3 * mt * mt * t, 3 * mt * t * t, t * t * t
		out[i] = {
			x = a * from.x + b * c1x + c * c2x + d * to.x,
			y = a * from.y + b * c1y + c * c2y + d * to.y,
		}
	end
	out[1] = { x = from.x, y = from.y }
	out[samples] = { x = to.x, y = to.y }
	return out
end

--- Seconds a move of `distPx` should take at `speedPxPerS` (default 4000), clamped to [0.06, 0.22].
function Motion.duration(distPx: number, speedPxPerS: number?): number
	local speed = speedPxPerS or DEFAULT_SPEED
	if speed <= 0 then
		speed = DEFAULT_SPEED
	end
	return math.clamp(math.abs(distPx) / speed, MIN_DURATION, MAX_DURATION)
end

local LABELS: { [string]: string } = {
	LeftShift = "Shift",
	RightShift = "Shift",
	LeftControl = "Ctrl",
	RightControl = "Ctrl",
	LeftAlt = "Alt",
	RightAlt = "Alt",
	Return = "Enter",
	KeypadEnter = "Enter",
	Backspace = "⌫",
}

--- Key-cap label for a KeyCode name: "W" → "W", "LeftShift" → "Shift", "Return" → "Enter".
function Motion.keyLabel(keyCodeName: string): string
	return LABELS[keyCodeName] or keyCodeName
end

return Motion
