//! What a process may do to this one: its integrity level.
//!
//! Windows keeps the input of a program from one that runs with fewer rights
//! (UIPI), and drops it without an error. The helper reads the level of a
//! program before it sends that program input, so the caller can be told.

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY, TokenIntegrityLevel,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

fn level_of_handle(process: HANDLE) -> i32 {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_err() {
            return -1;
        }
        let mut needed = 0u32;
        // The first call only says how large the answer is.
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut needed);
        let level = if needed == 0 {
            -1
        } else {
            // Eight-byte units, so the label inside is aligned.
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
            let ok = GetTokenInformation(
                token,
                TokenIntegrityLevel,
                Some(buffer.as_mut_ptr().cast()),
                needed,
                &mut needed,
            )
            .is_ok();
            if ok {
                let label = &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL);
                let sid = label.Label.Sid;
                let count = *GetSidSubAuthorityCount(sid);
                if count == 0 {
                    -1
                } else {
                    *GetSidSubAuthority(sid, u32::from(count) - 1) as i32
                }
            } else {
                -1
            }
        };
        let _ = CloseHandle(token);
        level
    }
}

/// A process's integrity level as a RID (0x1000 low, 0x2000 medium, 0x3000
/// high, 0x4000 system), or -1 when it cannot be read.
pub fn integrity(pid: u32) -> i32 {
    if pid == 0 {
        return -1;
    }
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return -1;
        };
        let level = level_of_handle(process);
        let _ = CloseHandle(process);
        level
    }
}

/// This process's own level.
pub fn self_integrity() -> i32 {
    // SAFETY: the pseudo handle of the current process needs no closing.
    level_of_handle(unsafe { GetCurrentProcess() })
}

/// Windows keeps this program's input from `pid`: it runs above this program, or cannot be read.
pub fn elevated(pid: u32, own: i32) -> bool {
    let r = integrity(pid);
    r < 0 || r > own
}

/// `pid` is positively read to run above this program's rights; unreadable is not a yes.
pub fn above(pid: u32, own: i32) -> bool {
    if pid == 0 {
        return false;
    }
    let r = integrity(pid);
    r >= 0 && r > own
}
