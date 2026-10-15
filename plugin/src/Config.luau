--!strict
return {
	VERSION = "0.1.0",
	DEFAULT_PORT = 38491,
	SETTING_SESSION = "Stagehand.Session",
	SETTING_PORT = "Stagehand.Port",
	-- Fallback transport (Transport/Remote): client nodes relay through the server node over a
	-- RemoteFunction instead of talking HTTP directly. Only for an injected client runtime.
	USE_REMOTE_RELAY = false,
}
