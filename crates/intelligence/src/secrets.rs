use std::fmt;

/// Wrapper that suppresses Debug/Display of secret material.
/// Use for API keys read from `tauri-plugin-keyring` before passing to providers.
pub struct Redacted<T>(T);

impl<T> Redacted<T> {
    pub fn new(value: T) -> Self {
        Self(value)
    }

    /// Escape hatch — call site must be explicit about exposing the secret.
    pub fn expose(&self) -> &T {
        &self.0
    }

    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T> fmt::Debug for Redacted<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

impl<T> fmt::Display for Redacted<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

impl<T: Clone> Clone for Redacted<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacted_debug_hides_inner() {
        let r = Redacted::new("sk-ant-api03-ABCDEF".to_string());
        assert_eq!(format!("{:?}", r), "***");
        assert_eq!(format!("{}", r), "***");
        assert_eq!(r.expose(), "sk-ant-api03-ABCDEF");
    }
}
