-- Minimal smoke script for run-in-roblox: proves plugin injection and the HTTP relay work.
print("Hello from inside Roblox Studio!")
print("Place:", game.Name, "| RunService:IsEdit() =", game:GetService("RunService"):IsEdit())
warn("warnings are relayed too")
