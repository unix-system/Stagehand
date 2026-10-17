-- Lune test entry: `lune run plugin/tests/run.luau` (from the repo root or plugin/).
local process = require("@lune/process")
local H = require("./harness")

require("./Resolve.spec")
require("./Conditions.spec")
require("./Registry.spec")
require("./Runner.spec")
require("./Node.spec")
require("./Motion.spec")
require("./ProgressModel.spec")

print(string.format("%d passed, %d failed", H.passed, H.failed))
for _, f in ipairs(H.failures) do
	print("FAIL " .. f)
end
process.exit(if H.failed == 0 then 0 else 1)
