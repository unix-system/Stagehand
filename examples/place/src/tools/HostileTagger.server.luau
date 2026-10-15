--!strict
-- Lives inside StarterPack.Gun and runs on the server once the tool is in a Backpack.
-- Equipping the Gun tags the character `Hostile`; unequipping removes the tag.

local CollectionService = game:GetService("CollectionService")

local tool = script.Parent :: Tool
local holder: Instance? = nil -- character currently holding the tool

tool.Equipped:Connect(function()
	holder = tool.Parent
	if holder and holder:IsA("Model") then
		CollectionService:AddTag(holder, "Hostile")
	end
end)

tool.Unequipped:Connect(function()
	if holder then
		CollectionService:RemoveTag(holder, "Hostile")
		holder = nil
	end
end)
