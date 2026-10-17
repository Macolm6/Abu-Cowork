use crate::error::HelperError;
use serde_json::{json, Value};
use std::path::Path;

fn unavailable() -> HelperError {
    HelperError::not_executed("file-name-comparison-unavailable", "Cannot determine directory file-name comparison")
}

pub(crate) fn directory_info(raw_path: &str) -> Result<Value, HelperError> {
    let path = Path::new(raw_path);
    if !path.is_absolute() {
        return Err(HelperError::not_executed("invalid-params", "Directory path must be absolute"));
    }
    let metadata = std::fs::metadata(path).map_err(|_| unavailable())?;
    if !metadata.is_dir() {
        return Err(HelperError::not_executed("invalid-params", "Name comparison requires a directory"));
    }
    platform_directory_info(path, &metadata)
}

#[cfg(target_os = "windows")]
fn platform_directory_info(path: &Path, _metadata: &std::fs::Metadata) -> Result<Value, HelperError> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandleEx, GetVolumeInformationByHandleW, FileCaseSensitiveInfo, FileIdInfo,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_ID_INFO,
    };
    use windows::Win32::System::WindowsProgramming::FILE_CASE_SENSITIVE_INFO;

    let directory = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(path)
        .map_err(|_| unavailable())?;
    if !directory.metadata().map_err(|_| unavailable())?.is_dir() {
        return Err(unavailable());
    }
    let handle = HANDLE(directory.as_raw_handle());
    let mut case_info = FILE_CASE_SENSITIVE_INFO::default();
    let mut identity = FILE_ID_INFO::default();
    let mut filesystem = [0u16; 64];
    // Both facts describe the same opened directory, including a junction target.
    unsafe {
        GetFileInformationByHandleEx(handle, FileCaseSensitiveInfo,
            &mut case_info as *mut _ as *mut _, std::mem::size_of_val(&case_info) as u32)
            .map_err(|_| unavailable())?;
        GetFileInformationByHandleEx(handle, FileIdInfo,
            &mut identity as *mut _ as *mut _, std::mem::size_of_val(&identity) as u32)
            .map_err(|_| unavailable())?;
        GetVolumeInformationByHandleW(handle, None, None, None, None, Some(&mut filesystem))
            .map_err(|_| unavailable())?;
    }
    let length = filesystem.iter().position(|unit| *unit == 0).ok_or_else(unavailable)?;
    let filesystem = String::from_utf16(&filesystem[..length]).map_err(|_| unavailable())?;
    Ok(json!({
        "caseMode": if case_info.Flags & 1 != 0 { "sensitive" } else { "insensitive" },
        "directoryIdentity": format!("{}:{:02x?}", identity.VolumeSerialNumber, identity.FileId.Identifier),
        "platform": "windows",
        "filesystem": filesystem,
    }))
}

#[cfg(target_os = "macos")]
fn platform_directory_info(path: &Path, metadata: &std::fs::Metadata) -> Result<Value, HelperError> {
    use std::os::unix::fs::MetadataExt;
    use std::os::fd::AsRawFd;
    use objc2_foundation::{NSNumber, NSString, NSURL, NSURLVolumeSupportsCaseSensitiveNamesKey};

    let directory = std::fs::File::open(path).map_err(|_| unavailable())?;
    let opened = directory.metadata().map_err(|_| unavailable())?;
    if !opened.is_dir() || opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
        return Err(unavailable());
    }
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    let filesystem = unsafe {
        if libc::fstatfs(directory.as_raw_fd(), filesystem.as_mut_ptr()) != 0 {
            return Err(unavailable());
        }
        filesystem.assume_init()
    };
    let filesystem = unsafe { std::ffi::CStr::from_ptr(filesystem.f_fstypename.as_ptr()) }
        .to_str().map_err(|_| unavailable())?;

    let text = path.to_str().ok_or_else(unavailable)?;
    let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(text), true);
    let mut value = None;
    // The documented volume resource is an NSNumber; validate the returned class.
    unsafe {
        url.removeCachedResourceValueForKey(NSURLVolumeSupportsCaseSensitiveNamesKey);
        url.getResourceValue_forKey_error(&mut value, NSURLVolumeSupportsCaseSensitiveNamesKey)
            .map_err(|_| unavailable())?;
    }
    let value = value.ok_or_else(unavailable)?;
    let number = value.downcast_ref::<NSNumber>().ok_or_else(unavailable)?;
    let current = std::fs::metadata(path).map_err(|_| unavailable())?;
    if current.dev() != metadata.dev() || current.ino() != metadata.ino() {
        return Err(HelperError::observe_again("directory-changed", "Directory changed while reading name comparison"));
    }
    Ok(json!({
        "caseMode": if number.boolValue() { "sensitive" } else { "insensitive" },
        "directoryIdentity": format!("{}:{}", metadata.dev(), metadata.ino()),
        "platform": "macos",
        "filesystem": filesystem,
    }))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn platform_directory_info(_path: &Path, _metadata: &std::fs::Metadata) -> Result<Value, HelperError> {
    Err(unavailable())
}
