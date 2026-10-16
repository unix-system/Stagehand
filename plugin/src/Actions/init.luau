--!nonstrict
-- Ordered list of static action modules. Order = entry order in schema/catalog.json.

local Actions = {}

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
