--[[
	gen-catalog — regenerate schema/catalog.json from the plugin's Actions metas (Lune).

	  lune run tools/gen-catalog.luau            # write to a temp path, compare with schema/catalog.json,
	                                             # exit 1 on drift (never touches the committed file)
	  lune run tools/gen-catalog.luau <path>     # write the generated file to <path> (same as --out)
	  lune run tools/gen-catalog.luau --stdout   # print it
	  lune run tools/gen-catalog.luau --write    # overwrite schema/catalog.json (intentional catalog change)

	CI runs `lune run tools/gen-catalog.luau schema/catalog.json && git diff --exit-code schema/catalog.json`;
	any difference between the metas in plugin/src/Actions and the committed file fails the build. Output is byte-for-byte Python
	json.dumps(indent=2) style (2-space indent, \uXXXX escapes, trailing newline), entries in
	Actions order (Session, Player, Character, Input, Gui, Remote, Instance, Log).

	Metas are loaded without Roblox services: Actions modules only touch Roblox APIs inside run().
]]

local fs = require("@lune/fs")
local process = require("@lune/process")
local stdio = require("@lune/stdio")

local Loader = require("./lib/loader")
local Json = Loader.requireModule(Loader.src.Json)
local Registry = Loader.requireModule(Loader.src.Registry)
local header = require("./catalog-header")

local function generate(): string
	return Json.encode(Registry.document(header), 2) .. "\n"
end

local function findSchemaPath(): string
	for _, p in ipairs({ "schema/catalog.json", "../schema/catalog.json", "../../schema/catalog.json" }) do
		if fs.isFile(p) then
			return p
		end
	end
	error("schema/catalog.json not found; run from the repository root")
end

local function firstDiff(a: string, b: string): (number, string?, string?)
	local la, lb = string.split(a, "\n"), string.split(b, "\n")
	for i = 1, math.max(#la, #lb) do
		if la[i] ~= lb[i] then
			return i, la[i], lb[i]
		end
	end
	return 0, nil, nil
end

local mode, outPath = "check", nil
local i = 1
while i <= #process.args do
	local a = process.args[i]
	if a == "--check" then
		mode = "check"
	elseif a == "--write" then
		mode = "write"
	elseif a == "--out" then
		mode = "out"
		i += 1
		outPath = process.args[i]
	elseif a == "--stdout" then
		mode = "stdout"
	elseif a:sub(1, 2) ~= "--" then
		mode = "out"
		outPath = a
	else
		stdio.ewrite("unknown argument " .. tostring(a) .. "\n")
		process.exit(2)
	end
	i += 1
end

local generated = generate()

if mode == "stdout" then
	stdio.write(generated)
elseif mode == "out" then
	assert(outPath, "--out needs a path")
	fs.writeFile(outPath, generated)
	print("wrote " .. outPath .. " (" .. #generated .. " bytes)")
elseif mode == "write" then
	local p = findSchemaPath()
	fs.writeFile(p, generated)
	print("wrote " .. p)
else
	local p = findSchemaPath()
	local tmpDir = process.env.TMPDIR or process.env.TEMP or process.env.TMP or "/tmp"
	local tmpPath = tmpDir .. "/stagehand-catalog.generated.json"
	pcall(fs.writeFile, tmpPath, generated)
	local committed = fs.readFile(p)
	if committed == generated then
		print("catalog OK: " .. p .. " matches plugin/src/Actions metas")
	else
		local line, want, got = firstDiff(committed, generated)
		stdio.ewrite(
			"catalog DRIFT at line "
				.. line
				.. "\n  committed: "
				.. tostring(want)
				.. "\n  generated: "
				.. tostring(got)
				.. "\n"
		)
		stdio.ewrite("generated copy: " .. tmpPath .. "\n")
		stdio.ewrite("Fix the metas in plugin/src/Actions (or run with --write for an intentional catalog change).\n")
		process.exit(1)
	end
end
