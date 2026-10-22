--!strict
return {
	VERSION = "0.1.0",
	DEFAULT_PORT = 45491,
	-- The daemon binds the first free port in [port, port + PORT_RANGE); the edit node keeps a node per
	-- port in that range so every running daemon (one per MCP client) sees this Studio.
	PORT_RANGE = 10,
	SETTING_SESSION = "Stagehand.Session",
	SETTING_SESSION_PORT = "Stagehand.SessionPort",
	SETTING_PORT = "Stagehand.Port",
	-- Client nodes relay through the server node over a RemoteFunction (Transport/Remote): in a
	-- Studio play client HttpService errors "Http requests can only be executed by game server".
	USE_REMOTE_RELAY = true,
	-- Input visualisation (docs/plugin.md): client nodes draw a cursor, motion trail, click rings and
	-- a key strip in a CoreGui ScreenGui, and input.click / input.mouseMove glide the mouse along a
	-- short curve instead of teleporting it. Set false to send raw VirtualInput only.
	INPUT_VISUALS = true,
	-- Cursor glide speed in screen pixels per second; each move is clamped to 0.06–0.22 s.
	MOUSE_SPEED_PX_S = 4000,
	-- Uploaded logo image: toolbar button and widget headers.
	LOGO = "rbxassetid://129273251778096",
}
