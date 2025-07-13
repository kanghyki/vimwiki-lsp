# vimwiki-lsp

Language Server Protocol (LSP) support for VimWiki, using `coc.nvim`.

---

## 📦 Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/kanghyki/vimwiki-lsp.git
````

### 2. Install Dependencies

```bash
cd vimwiki-lsp && npm install
```

### 3. Add the Following Settings to `coc-settings.json`

* `wikiRoot`: the path to your local VimWiki directory
* `args`: the path to the installed `vimwiki-lsp` repository

```json
"languageserver": {
  "vimwiki": {
    "initializationOptions": {
      "wikiRoot": "/your/path/to/wiki"
    },
    "command": "node",
    "args": ["/your/path/to/vimwiki-lsp/index.js"],
    "filetypes": ["vimwiki"],
    "rootPatterns": [".git", "."]
  }
}
```

---

## ⚙️ VimWiki Configuration Example

In your `init.vim` or `.vimrc`, add the following to configure VimWiki:

```vim
let g:vimwiki_list = [
      \ {
      \   'path': '~/Desktop/wiki',
      \   'ext': '.md',
      \   'diary_rel_path': '.',
      \ },
      \ ]
```

> This sets your VimWiki directory to `~/Desktop/wiki`, uses `.md` as the file extension, and stores diary entries in the root wiki folder.

---

## 📝 Notes

* Make sure `coc.nvim` is installed and properly configured in your Neovim.
* This server is designed to work with `.md`-based VimWiki setups.
* It is compatible with diary entries and custom wiki paths.

## 🖼️ ScreenShot

<img width="410" height="276" alt="Screenshot 2025-07-13 at 11 57 34" src="https://github.com/user-attachments/assets/75505ec8-78ad-4227-8d38-5ac59deee421" />
<img width="293" height="187" alt="Screenshot 2025-07-13 at 11 57 47" src="https://github.com/user-attachments/assets/b7f639a9-0cf3-4c5e-8903-606650744554" />

---

## 📄 License

MIT License
