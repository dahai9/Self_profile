# Dahai's Blog (Self_profile)

A modern, high-performance blog built with **Astro**, **TypeScript**, and **Nix**.

## 🚀 Features

- **Framework**: [Astro](https://astro.build/) (Static Site Generation)
- **Styling**: Minimal CSS (Bear Blog theme)
- **Content**: Markdown & MDX support in `src/content/blog/`
- **Environment**: Nix Flake with `direnv` support
- **Deployment**: Automated via GitHub Actions to [GitHub Pages](https://dahai9.github.io/Self_profile/)

## 🛠️ Development

This project uses **Nix Flakes** for a reproducible development environment.

### 1. Enable Environment
If you have `direnv` installed:
```sh
direnv allow
```
Otherwise, use:
```sh
nix develop
```

### 2. Commands
| Command | Action |
| :--- | :--- |
| `npm run dev` | Start local development server |
| `npm run build` | Build for production |
| `npm run preview` | Preview the production build |
| `npm run typecheck` | Run Astro and TypeScript checks |

## 📦 Project Structure

- `src/content/blog/`: Markdown/MDX blog posts
- `astro.config.mjs`: Astro configuration (site: `https://dahai9.github.io`, base: `/Self_profile`)
- `flake.nix`: Nix environment configuration
- `.github/workflows/deploy.yml`: GitHub Actions CI/CD pipeline

## 🚢 Deployment

Deployment is automatic. Any push to the `main` branch will trigger a GitHub Action that builds the site and deploys it to GitHub Pages.
