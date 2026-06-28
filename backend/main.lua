local logger = require("logger")
local millennium = require("millennium")
local ffi = require("ffi")

ffi.cdef[[
typedef unsigned long DWORD;
typedef int BOOL;
typedef unsigned short WORD;
typedef unsigned short WCHAR;
typedef void* HANDLE;
typedef struct _STARTUPINFOW {
  DWORD cb;
  WCHAR* lpReserved;
  WCHAR* lpDesktop;
  WCHAR* lpTitle;
  DWORD dwX;
  DWORD dwY;
  DWORD dwXSize;
  DWORD dwYSize;
  DWORD dwXCountChars;
  DWORD dwYCountChars;
  DWORD dwFillAttribute;
  DWORD dwFlags;
  WORD wShowWindow;
  WORD cbReserved2;
  void* lpReserved2;
  HANDLE hStdInput;
  HANDLE hStdOutput;
  HANDLE hStdError;
} STARTUPINFOW;
typedef struct _PROCESS_INFORMATION {
  HANDLE hProcess;
  HANDLE hThread;
  DWORD dwProcessId;
  DWORD dwThreadId;
} PROCESS_INFORMATION;
BOOL CreateProcessW(WCHAR* lpApplicationName, WCHAR* lpCommandLine, void* lpProcessAttributes, void* lpThreadAttributes, BOOL bInheritHandles, DWORD dwCreationFlags, void* lpEnvironment, WCHAR* lpCurrentDirectory, STARTUPINFOW* lpStartupInfo, PROCESS_INFORMATION* lpProcessInformation);
DWORD WaitForSingleObject(HANDLE hHandle, DWORD dwMilliseconds);
BOOL CloseHandle(HANDLE hObject);
BOOL GetExitCodeProcess(HANDLE hProcess, DWORD* lpExitCode);
]]

local function quote(value)
    value = tostring(value or "")
    value = value:gsub("\\", "\\\\")
    value = value:gsub('"', '\\"')
    return '"' .. value .. '"'
end

local function cmd_quote(value)
    value = tostring(value or "")
    return '"' .. value .. '"'
end

local function cmd_escape(value)
    value = tostring(value or "")
    value = value:gsub('"', '^"')
    return value
end

local function to_wide(value)
    value = tostring(value or "")
    local buffer = ffi.new("WCHAR[?]", #value + 1)
    for index = 1, #value do
        buffer[index - 1] = value:byte(index)
    end
    buffer[#value] = 0
    return buffer
end

local function run_hidden_command(command)
    local startup = ffi.new("STARTUPINFOW")
    local process = ffi.new("PROCESS_INFORMATION")
    startup.cb = ffi.sizeof(startup)

    local command_w = to_wide(command)
    local create_no_window = 0x08000000
    local ok = ffi.C.CreateProcessW(nil, command_w, nil, nil, 0, create_no_window, nil, nil, startup, process)
    if ok == 0 then
        return false, "Failed to start hidden process"
    end

    ffi.C.WaitForSingleObject(process.hProcess, 0xFFFFFFFF)
    local exit_code = ffi.new("DWORD[1]")
    ffi.C.GetExitCodeProcess(process.hProcess, exit_code)
    ffi.C.CloseHandle(process.hThread)
    ffi.C.CloseHandle(process.hProcess)

    return tonumber(exit_code[0]) == 0, "exit " .. tostring(tonumber(exit_code[0]))
end

local function json_escape(value)
    value = tostring(value or "")
    value = value:gsub("\\", "\\\\")
    value = value:gsub('"', '\\"')
    value = value:gsub("\r", "\\r")
    value = value:gsub("\n", "\\n")
    return value
end

local function plugin_root()
    local source = debug.getinfo(1, "S").source:gsub("^@", "")
    return source:match("^(.*)[/\\]backend[/\\]main%.lua$") or "."
end

local function steam_root()
    local root = plugin_root()
    return root:match("^(.*)[/\\]millennium[/\\]plugins[/\\][^/\\]+$") or "C:\\Program Files (x86)\\Steam"
end

local function unquote_yaml(value)
    value = tostring(value or ""):match("^%s*(.-)%s*$") or ""
    local first = value:sub(1, 1)
    local last = value:sub(-1)
    if (first == '"' and last == '"') or (first == "'" and last == "'") then
        value = value:sub(2, -2)
    end
    return value:gsub("\\\\", "\\")
end

local function read_hubcap_config()
    local path = steam_root() .. "\\config\\hubcaptools\\config.yaml"
    local file = io.open(path, "r")
    if file == nil then
        return nil, "HubcapTool config.yaml not found at " .. path
    end

    local config = { configPath = path }
    for line in file:lines() do
        local key, value = line:match("^%s*(HubcapApiKey)%s*:%s*(.-)%s*$")
        if key ~= nil then
            config[key] = unquote_yaml(value)
        end

        key, value = line:match("^%s*(HubcapLuaDir)%s*:%s*(.-)%s*$")
        if key ~= nil then
            config[key] = unquote_yaml(value)
        end
    end
    file:close()

    if config.HubcapApiKey == nil or config.HubcapApiKey == "" then
        return nil, "HubcapApiKey is missing in " .. path
    end

    if config.HubcapLuaDir == nil or config.HubcapLuaDir == "" then
        return nil, "HubcapLuaDir is missing in " .. path
    end

    return config, nil
end

local function app_id_from_payload(payload)
    local app_id = nil
    if type(payload) == "table" then
        app_id = payload.app_id or payload.appId or payload[1]
    else
        app_id = payload
    end

    return tostring(app_id or ""):match("^(%d+)$")
end

local function lua_path_for_app(app_id)
    local config, error = read_hubcap_config()
    if config == nil then
        return nil, error
    end

    return config.HubcapLuaDir .. "\\" .. app_id .. ".lua", nil, config
end

local function manifest_marker_path_for_app(app_id)
    local config, error = read_hubcap_config()
    if config == nil then
        return nil, error
    end

    local manifest_dir = steam_root() .. "\\depotcache"
    return steam_root() .. "\\config\\hubcapplugin-manifest-" .. app_id .. ".txt", nil, config, manifest_dir
end

local function file_exists(path)
    local file = io.open(path, "rb")
    if file ~= nil then
        file:close()
        return true
    end
    return false
end

local function run_powershell(args)
    local script = plugin_root() .. "\\backend\\scripts\\download_lua.ps1"
    local temp_base = os.getenv("TEMP") or os.getenv("TMP") or plugin_root()
    local stamp = tostring(os.time()) .. "-" .. tostring(math.random(100000, 999999))
    local output_path = temp_base .. "\\hubcapplugin-" .. stamp .. ".out"
    local error_path = temp_base .. "\\hubcapplugin-" .. stamp .. ".err"
    local powershell_command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " ..
        cmd_quote(script) .. " " .. args .. " > " .. cmd_quote(output_path) .. " 2> " .. cmd_quote(error_path)
    local command = 'cmd.exe /S /C "' .. cmd_escape(powershell_command) .. '"'

    local ok, reason = run_hidden_command(command)

    local output = ""
    local output_file = io.open(output_path, "r")
    if output_file ~= nil then
        output = output_file:read("*a") or ""
        output_file:close()
        os.remove(output_path)
    end

    local error_output = ""
    local error_file = io.open(error_path, "r")
    if error_file ~= nil then
        error_output = error_file:read("*a") or ""
        error_file:close()
        os.remove(error_path)
    end

    if not ok then
        logger:error("Hubcap Plugin command failed: " .. tostring(reason))
    end

    if output ~= "" then
        return output
    end

    if error_output ~= "" then
        return '{"success":false,"error":"' .. json_escape(error_output) .. '"}'
    end

    return '{"success":false,"error":"Download helper returned no output."}'
end

function download_lua_for_app(payload)
    local app_id = app_id_from_payload(payload)
    if app_id == nil then
        return '{"success":false,"error":"Invalid Steam app id"}'
    end

    return run_powershell("-AppId " .. quote(app_id))
end

function download_manifest_for_app(payload)
    local app_id = app_id_from_payload(payload)
    if app_id == nil then
        return '{"success":false,"error":"Invalid Steam app id"}'
    end

    return run_powershell("-AppId " .. quote(app_id) .. " -Artifact manifest")
end

function check_lua_for_app(payload)
    local app_id = app_id_from_payload(payload)
    if app_id == nil then
        return '{"success":false,"error":"Invalid Steam app id"}'
    end

    local path, error, config = lua_path_for_app(app_id)
    if path == nil then
        return '{"success":false,"error":"' .. json_escape(error) .. '"}'
    end

    return '{"success":true,"appId":"' .. app_id .. '","exists":' .. tostring(file_exists(path)) .. ',"luaDir":"' .. json_escape(config.HubcapLuaDir) .. '","luaFiles":["' .. json_escape(path) .. '"]}'
end

function delete_lua_for_app(payload)
    local app_id = app_id_from_payload(payload)
    if app_id == nil then
        return '{"success":false,"error":"Invalid Steam app id"}'
    end

    return run_powershell("-AppId " .. quote(app_id) .. " -DeleteLua")
end

function check_lua_status_for_app(payload)
    local app_id = app_id_from_payload(payload)
    if app_id == nil then
        return '{"success":false,"error":"Invalid Steam app id"}'
    end

    return run_powershell("-AppId " .. quote(app_id) .. " -StatusOnly")
end

function check_hubcap_limit()
    return run_powershell("-UserStats")
end

function check_manifest_for_app(payload)
    local app_id = app_id_from_payload(payload)
    if app_id == nil then
        return '{"success":false,"error":"Invalid Steam app id"}'
    end

    local path, error, config, manifest_dir = manifest_marker_path_for_app(app_id)
    if path == nil then
        return '{"success":false,"error":"' .. json_escape(error) .. '"}'
    end

    return '{"success":true,"appId":"' .. app_id .. '","exists":' .. tostring(file_exists(path)) .. ',"manifestDir":"' .. json_escape(manifest_dir) .. '","markerPath":"' .. json_escape(path) .. '"}'
end

function delete_manifest_for_app(payload)
    local app_id = app_id_from_payload(payload)
    if app_id == nil then
        return '{"success":false,"error":"Invalid Steam app id"}'
    end

    return run_powershell("-AppId " .. quote(app_id) .. " -DeleteManifest")
end

function check_hubcap_tool()
    local config, error = read_hubcap_config()
    if config == nil then
        return '{"success":false,"error":"' .. json_escape(error) .. '"}'
    end

    return '{"success":true,"configPath":"' .. json_escape(config.configPath) .. '","luaDir":"' .. json_escape(config.HubcapLuaDir) .. '","hasApiKey":true}'
end

local function on_load()
    logger:info("Hubcap Plugin loaded")
    millennium.ready()
end

local function on_unload()
    logger:info("Hubcap Plugin unloaded")
end

return {
    on_load = on_load,
    on_unload = on_unload
}
