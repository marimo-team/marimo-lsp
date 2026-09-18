import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const run = NodeUtil.promisify(NodeChildProcess.execFile);

// Match marimo's registry ACL policy without requiring a native Python host.
// Paths are passed as data, never interpolated into PowerShell source.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:MARIMO_DISCOVERY_PATH
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($user, 'S-1-5-18', 'S-1-5-32-544')

if ($env:MARIMO_DISCOVERY_CREATE -eq '1') {
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetSecurityDescriptorSddlForm(
        ('O:{0}D:P(A;OICI;FA;;;{0})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' -f $user)
    )
    # Apply the protected DACL at creation, not after exposing a directory.
    [void][System.IO.Directory]::CreateDirectory($path, $security)
}

$attributes = [System.IO.File]::GetAttributes($path)
if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Discovery path is a link: $path"
}
$isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
if ($env:MARIMO_DISCOVERY_CREATE -eq '1' -and -not $isDirectory) {
    throw "Discovery path is not a directory: $path"
}
$sections = [System.Security.AccessControl.AccessControlSections]'Owner, Access'
$acl = if ($isDirectory) {
    [System.IO.Directory]::GetAccessControl($path, $sections)
} else {
    [System.IO.File]::GetAccessControl($path, $sections)
}
$descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new(
    $acl.GetSecurityDescriptorBinaryForm(), 0
)
if ($null -eq $descriptor.Owner -or $trusted -notcontains $descriptor.Owner.Value) {
    throw "Discovery path has an unexpected Windows owner: $path"
}
if ($null -eq $descriptor.DiscretionaryAcl) {
    throw "Cannot inspect discovery ACL: $path"
}
foreach ($ace in $descriptor.DiscretionaryAcl) {
    if ($ace.AceType -eq [System.Security.AccessControl.AceType]::AccessDenied) {
        continue
    }
    if ($ace.AceType -ne [System.Security.AccessControl.AceType]::AccessAllowed) {
        throw "Discovery path has an unsupported Windows ACL: $path"
    }
    if ($trusted -notcontains $ace.SecurityIdentifier.Value) {
        throw "Discovery path is accessible to other users: $path"
    }
}
`;

/** Create or verify a path restricted to the current user and Windows admins. */
export async function windowsPrivatePath(
  path: string,
  createDirectory = false,
) {
  await run(
    NodePath.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      timeout: 15_000,
      env: {
        ...process.env,
        MARIMO_DISCOVERY_PATH: path,
        MARIMO_DISCOVERY_CREATE: createDirectory ? "1" : "0",
      },
    },
  );
}
