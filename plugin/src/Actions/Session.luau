--!nonstrict
-- session.* actions

local Meta = require(script.Parent.Parent.Meta)
local Env = require(script.Parent.Parent.Env)
local Errors = require(script.Parent.Parent.Errors)

local S = Meta.S
local ALL = { "edit", "server", "client" }

return {
	entries = {
		Meta.define({
			name = "session.wait",
			kind = "action",
			contexts = ALL,
			default = "server",
			summary = "Sleep for a fixed duration.",
			actor = "none",
			params = S.params({ { "duration", S.duration() } }, { "duration" }),
		}, {
			run = function(ctx, p)
				ctx.sleep(p.duration)
				return nil
			end,
		}),

		Meta.define({
			name = "session.addPlayers",
			kind = "action",
			contexts = { "server" },
			default = "server",
			summary = "Add simulated players to a multiplayer session (StudioTestService:AddPlayers). New clients get the next playerIndex.",
			actor = "none",
			params = S.params({
				{
					"count",
					{ type = "integer", minimum = 1, maximum = 7, description = "1..7, total players must stay <= 8" },
				},
			}, { "count" }),
		}, {
			run = function(ctx, p)
				local sts = Env.service("StudioTestService")
				if not sts then
					Errors.throw("SESSION_ERROR", "StudioTestService is not available in this context")
				end
				local ok, err = pcall(function()
					sts:AddPlayers(p.count)
				end)
				if not ok then
					Errors.throw("SESSION_ERROR", "AddPlayers failed: " .. tostring(err))
				end
				if ctx.node and ctx.node.onPlayersRequested then
					ctx.node:onPlayersRequested(p.count)
				end
				return p.count
			end,
		}),

		Meta.define({
			name = "session.disconnect",
			kind = "action",
			contexts = { "server" },
			default = "server",
			summary = "Disconnect the actor's player (Player:Kick).",
			actor = "required",
			params = S.params({ { "message", S.string("Kick message") } }, {}),
		}, {
			run = function(ctx, p)
				local player = ctx.player()
				player:Kick(p.message or "Disconnected by Stagehand")
				return nil
			end,
		}),
	},
}
