--!strict
return {
	VERSION = "0.1.0",
	DEFAULT_PORT = 38491,
	SETTING_SESSION = "Stagehand.Session",
	SETTING_PORT = "Stagehand.Port",
	-- Client nodes relay through the server node over a RemoteFunction (Transport/Remote): in a
	-- Studio play client HttpService errors "Http requests can only be executed by game server".
	USE_REMOTE_RELAY = true,
}
