//! Project folder conventions: create / open / list. Project folder is the
//! portable unit (zip + move + unzip + open just works) — no absolute paths
//! are stored inside `project.sqlite`.

use crate::error::StorageError;
use crate::project_db::{ProjectDb, PROJECT_DB_FILENAME};
use std::path::{Path, PathBuf};

pub const FOLDER_FORMAT_VERSION: &str = "1";
pub const STORY_FILENAME: &str = "story.story";
pub const ASSETS_DIRNAME: &str = "assets";
pub const EXPORTS_DIRNAME: &str = "exports";
pub const META_DIRNAME: &str = ".storycapture";
pub const VERSION_FILENAME: &str = "version.txt";
pub const DB_FILENAME: &str = PROJECT_DB_FILENAME;

pub struct ProjectFolder {
    root: PathBuf,
    db: ProjectDb,
}

impl ProjectFolder {
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn db(&self) -> &ProjectDb {
        &self.db
    }
    pub fn db_mut(&mut self) -> &mut ProjectDb {
        &mut self.db
    }
    pub fn assets_dir(&self) -> PathBuf {
        self.root.join(ASSETS_DIRNAME)
    }
    pub fn exports_dir(&self) -> PathBuf {
        self.root.join(EXPORTS_DIRNAME)
    }
    pub fn story_path(&self) -> PathBuf {
        self.root.join(STORY_FILENAME)
    }
    pub fn meta_dir(&self) -> PathBuf {
        self.root.join(META_DIRNAME)
    }
    pub fn version_file(&self) -> PathBuf {
        self.meta_dir().join(VERSION_FILENAME)
    }
}

fn starter_story_content(name: &str) -> String {
    let safe = name.replace('"', "\\\"");
    format!(
        "story \"{name}\" {{\n  meta {{\n    app: \"https://example.com\"\n    viewport: desktop\n    theme: dark\n    speed: 1.0\n  }}\n\n  scene \"{name}\" {{\n    pause\n  }}\n}}\n",
        name = safe
    )
}

/// Create a new project folder under `parent`, derive the folder name from
/// `name` via slugification, scaffold all subdirs, write the starter story
/// file and version marker, then initialize `project.sqlite`.
pub fn create_project(parent: &Path, name: &str) -> Result<ProjectFolder, StorageError> {
    if !parent.exists() {
        std::fs::create_dir_all(parent)?;
    }
    let slug = slug::slugify(name);
    if slug.is_empty() {
        return Err(StorageError::InvalidProjectFolder(format!(
            "name {name:?} slugifies to empty string"
        )));
    }
    let root = parent.join(&slug);
    if root.exists() {
        return Err(StorageError::AlreadyExists(format!(
            "project folder already exists: {}",
            root.display()
        )));
    }

    std::fs::create_dir_all(&root)?;
    std::fs::create_dir_all(root.join(ASSETS_DIRNAME))?;
    std::fs::create_dir_all(root.join(EXPORTS_DIRNAME))?;
    std::fs::create_dir_all(root.join(META_DIRNAME))?;

    std::fs::write(
        root.join(META_DIRNAME).join(VERSION_FILENAME),
        FOLDER_FORMAT_VERSION,
    )?;
    std::fs::write(root.join(STORY_FILENAME), starter_story_content(name))?;

    let db = ProjectDb::open(&root)?;
    Ok(ProjectFolder { root, db })
}

/// Open an existing project folder. Verifies the format-version marker. Does
/// NOT auto-upgrade folder format on mismatch.
pub fn open_project(folder: &Path) -> Result<ProjectFolder, StorageError> {
    if !folder.is_dir() {
        return Err(StorageError::InvalidProjectFolder(format!(
            "not a directory: {}",
            folder.display()
        )));
    }
    let version_file = folder.join(META_DIRNAME).join(VERSION_FILENAME);
    if !version_file.exists() {
        return Err(StorageError::InvalidProjectFolder(format!(
            "missing {}/{}",
            META_DIRNAME, VERSION_FILENAME
        )));
    }
    let version = std::fs::read_to_string(&version_file)?;
    let version = version.trim();
    if version != FOLDER_FORMAT_VERSION {
        return Err(StorageError::InvalidProjectFolder(format!(
            "unsupported folder format version {version:?}, expected {FOLDER_FORMAT_VERSION:?}"
        )));
    }
    let db = ProjectDb::open(folder)?;
    Ok(ProjectFolder {
        root: folder.to_path_buf(),
        db,
    })
}

/// Walk `parent` for direct subdirectories that contain a valid project marker.
pub fn list_projects(parent: &Path) -> Result<Vec<PathBuf>, StorageError> {
    if !parent.is_dir() {
        return Ok(vec![]);
    }
    let mut found = Vec::new();
    for entry in std::fs::read_dir(parent)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() && path.join(META_DIRNAME).join(VERSION_FILENAME).is_file() {
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}
