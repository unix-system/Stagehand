--!strict
-- Pure-Luau SHA-1 (hex digest). Used for the node.ready catalogHash; not security-relevant.

local band, bor, bxor, bnot, lrotate = bit32.band, bit32.bor, bit32.bxor, bit32.bnot, bit32.lrotate

local function sha1(msg: string): string
	local h0, h1, h2, h3, h4 = 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0
	local ml = #msg * 8
	msg ..= "\128"
	msg ..= string.rep("\0", (56 - #msg % 64) % 64)
	local hi = math.floor(ml / 2 ^ 32)
	local lo = ml % 2 ^ 32
	msg ..= string.pack(">I4I4", hi, lo)
	local w = table.create(80, 0)
	for chunk = 1, #msg, 64 do
		for i = 0, 15 do
			w[i + 1] = (string.unpack(">I4", msg, chunk + i * 4))
		end
		for i = 17, 80 do
			w[i] = lrotate(bxor(w[i - 3], w[i - 8], w[i - 14], w[i - 16]), 1)
		end
		local a, b, c, d, e = h0, h1, h2, h3, h4
		for i = 1, 80 do
			local f, k
			if i <= 20 then
				f = bor(band(b, c), band(bnot(b), d))
				k = 0x5A827999
			elseif i <= 40 then
				f = bxor(b, c, d)
				k = 0x6ED9EBA1
			elseif i <= 60 then
				f = bor(band(b, c), band(b, d), band(c, d))
				k = 0x8F1BBCDC
			else
				f = bxor(b, c, d)
				k = 0xCA62C1D6
			end
			local temp = (lrotate(a, 5) + f + e + k + w[i]) % 2 ^ 32
			e = d
			d = c
			c = lrotate(b, 30)
			b = a
			a = temp
		end
		h0 = (h0 + a) % 2 ^ 32
		h1 = (h1 + b) % 2 ^ 32
		h2 = (h2 + c) % 2 ^ 32
		h3 = (h3 + d) % 2 ^ 32
		h4 = (h4 + e) % 2 ^ 32
	end
	return string.format("%08x%08x%08x%08x%08x", h0, h1, h2, h3, h4)
end

return sha1
