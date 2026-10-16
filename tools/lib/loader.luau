--!nonstrict
--[[
	loader — a tiny Instance-based module system so plugin/src loads under Lune.

	Plugin modules only use Roblox-style requires (`require(script.Parent.Json)`). This mounts a
	source directory as a fake Instance tree, mirroring Rojo's file mapping:

	  dir/            Folder (or the init file's class if it has init.luau / init.server.luau / ...)
	  X.luau          ModuleScript "X"
	  X.server.luau   Script "X"         X.client.luau   LocalScript "X"

	`requireModule(instance)` compiles the file with @lune/luau in an environment that inherits the
	caller's globals plus `script = instance` and `require = <shim>`; results are cached per instance.

	  local Loader = require("../../tools/lib/loader")
	  local Resolve = Loader.requireModule(Loader.src.Resolve)
]]

local fs = require("@lune/fs")
local luau = require("@lune/luau")

local Loader = {}

type Node = { name: string, className: string, path: string, file: string?, children: { [string]: any }, order: { any } }

local nodes: { [any]: Node } = setmetatable({}, { __mode = "k" }) :: any
local cache: { [any]: any } = {}
local loading: { [any]: boolean } = {}

local methods = {}
local meta = {}

function meta.__index(self, key)
	local m = methods[key]
	if m ~= nil then
		return m
	end
	local child = nodes[self].children[key]
	if child == nil then
		error(string.format("%s is not a valid member of %s %q", tostring(key), nodes[self].className, self.Name), 2)
	end
	return child
end

function meta.__tostring(self)
	return self.Name
end

function methods.FindFirstChild(self, name: string)
	return nodes[self].children[name]
end

function methods.WaitForChild(self, name: string)
	local child = nodes[self].children[name]
	if child == nil then
		error(string.format("WaitForChild: %q has no child %q", self.Name, name), 2)
	end
	return child
end

function methods.GetChildren(self)
	return table.clone(nodes[self].order)
end

function methods.IsA(self, className: string): boolean
	local own = self.ClassName
	return own == className
		or className == "Instance"
		or (className == "LuaSourceContainer" and own ~= "Folder")
		or (className == "BaseScript" and (own == "Script" or own == "LocalScript"))
		or (className == "Script" and own == "LocalScript")
end

function methods.GetFullName(self): string
	local parts = {}
	local cur = self
	while cur do
		table.insert(parts, 1, cur.Name)
		cur = cur.Parent
	end
	return table.concat(parts, ".")
end

local SCRIPT_SUFFIXES = {
	{ ".server.luau", "Script" },
	{ ".client.luau", "LocalScript" },
	{ ".luau", "ModuleScript" },
}

local function classify(fileName: string): (string?, string?)
	for _, s in ipairs(SCRIPT_SUFFIXES) do
		local suffix = s[1]
		if #fileName > #suffix and string.sub(fileName, -#suffix) == suffix then
			return string.sub(fileName, 1, -#suffix - 1), s[2]
		end
	end
	return nil, nil
end

local function newInstance(name: string, className: string, path: string, file: string?, parent: any)
	local inst = setmetatable({ Name = name, ClassName = className, Parent = parent }, meta)
	nodes[inst] = { name = name, className = className, path = path, file = file, children = {}, order = {} }
	if parent then
		local p = nodes[parent]
		p.children[name] = inst
		table.insert(p.order, inst)
	end
	return inst
end

local function mountDir(dir: string, name: string, parent: any)
	local entries = fs.readDir(dir)
	table.sort(entries)
	local className, initFile = "Folder", nil
	for _, e in ipairs(entries) do
		local base, cls = classify(e)
		if base == "init" and fs.isFile(dir .. "/" .. e) then
			className, initFile = cls :: string, dir .. "/" .. e
		end
	end
	local inst = newInstance(name, className, dir, initFile, parent)
	for _, e in ipairs(entries) do
		local full = dir .. "/" .. e
		if fs.isDir(full) then
			mountDir(full, e, inst)
		else
			local base, cls = classify(e)
			if base and base ~= "init" then
				newInstance(base, cls :: string, full, full, inst)
			end
		end
	end
	return inst
end

local mounts: { [string]: any } = {}

--- Mount a source directory on disk as a fake Instance tree (cached per directory).
function Loader.mount(dir: string, name: string?)
	if mounts[dir] == nil then
		assert(fs.isDir(dir), "loader: not a directory: " .. dir)
		mounts[dir] = mountDir(dir, name or string.match(dir, "([^/]+)/*$") or dir, nil)
	end
	return mounts[dir]
end

--- Require a fake ModuleScript: compile its file with `script`/`require` bound to the tree.
function Loader.requireModule(inst: any): any
	local node = nodes[inst]
	if node == nil then
		error("loader: require expects a mounted Instance, got " .. typeof(inst) .. " " .. tostring(inst), 2)
	end
	if cache[inst] ~= nil then
		return cache[inst]
	end
	if node.className ~= "ModuleScript" or node.file == nil then
		error(string.format("loader: %s is a %s, not a ModuleScript", inst:GetFullName(), node.className), 2)
	end
	if loading[inst] then
		error("loader: cyclic require of " .. inst:GetFullName(), 2)
	end
	loading[inst] = true
	local env = setmetatable({ script = inst, require = Loader.requireModule }, { __index = getfenv(0) })
	local chunk = luau.load(fs.readFile(node.file :: string), { debugName = node.file, environment = env })
	local ok, result = pcall(chunk)
	loading[inst] = nil
	if not ok then
		error(result, 0)
	end
	if result == nil then
		error("loader: module " .. inst:GetFullName() .. " did not return a value", 2)
	end
	cache[inst] = result
	return result
end

-- Repository root, from this file's own path (tools/lib/loader).
local here = debug.info(1, "s")
local repoRoot = string.match(here, "^(.*)/tools/lib/loader[^/]*$") or "."
Loader.repoRoot = repoRoot

--- plugin/src mounted as the plugin's root Script ("Stagehand").
Loader.src = Loader.mount(repoRoot .. "/plugin/src", "Stagehand")

return Loader
