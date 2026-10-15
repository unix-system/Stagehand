--!strict
-- Minimal pure-Luau signal (used for cancellation and UI updates; works under Lune).

export type Connection = { Disconnect: (self: Connection) -> (), Connected: boolean }
export type Signal = {
	Connect: (self: Signal, fn: (...any) -> ()) -> Connection,
	Fire: (self: Signal, ...any) -> (),
	DisconnectAll: (self: Signal) -> (),
}

local Signal = {}
Signal.__index = Signal

function Signal.new(): Signal
	return (setmetatable({ _handlers = {} }, Signal) :: any) :: Signal
end

function Signal:Connect(fn)
	local handlers = self._handlers
	local conn = { Connected = true }
	function conn.Disconnect(c)
		c.Connected = false
		for i, h in ipairs(handlers) do
			if h == fn then
				table.remove(handlers, i)
				break
			end
		end
	end
	table.insert(handlers, fn)
	return conn
end

function Signal:Fire(...)
	local snapshot = table.clone(self._handlers)
	for _, fn in ipairs(snapshot) do
		local ok, err = pcall(fn, ...)
		if not ok then
			warn("[Stagehand] signal handler error: " .. tostring(err))
		end
	end
end

function Signal:DisconnectAll()
	table.clear(self._handlers)
end

return Signal
