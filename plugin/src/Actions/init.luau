--!nonstrict
-- Ordered list of static action modules. Order = entry order in schema/catalog.json.

local Actions = {}

if script then
	Actions.Session = require(script.Session)
	Actions.Player = require(script.Player)
	Actions.Character = require(script.Character)
	Actions.Input = require(script.Input)
	Actions.Gui = require(script.Gui)
	Actions.Remote = require(script.Remote)
	Actions.Instance = require(script.Instance)
	Actions.Log = require(script.Log)
	Actions.GameHooks = require(script.GameHooks)
	Actions.Lua = require(script.Lua)
else
	Actions.Session = require("@self/Session")
	Actions.Player = require("@self/Player")
	Actions.Character = require("@self/Character")
	Actions.Input = require("@self/Input")
	Actions.Gui = require("@self/Gui")
	Actions.Remote = require("@self/Remote")
	Actions.Instance = require("@self/Instance")
	Actions.Log = require("@self/Log")
	Actions.GameHooks = require("@self/GameHooks")
	Actions.Lua = require("@self/Lua")
end

Actions.ORDER = { "Session", "Player", "Character", "Input", "Gui", "Remote", "Instance", "Log" }

--- Static entries in catalog order.
function Actions.static(): { any }
	local out = {}
	for _, name in ipairs(Actions.ORDER) do
		for _, entry in ipairs(Actions[name].entries) do
			table.insert(out, entry)
		end
	end
	return out
end

return Actions
