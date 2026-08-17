# Installing Baker

Follow these steps in order. It takes a few minutes.

If you get stuck, see [If something goes wrong](#if-something-goes-wrong) at the bottom.

## 1. Install Node.js and git

Baker runs on Node.js and uses git to fetch configurations. Install both first.

**macOS**

```bash
brew install node git
```

**Windows** — in PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS Git.Git
```

**Linux**

```bash
sudo apt install nodejs npm git      # Debian / Ubuntu
sudo dnf install nodejs npm git      # Fedora / RHEL
```

Any current version of Node works. Check both are installed:

```bash
node --version
git --version
```

If either says "not found", close your terminal and open a new one — installers usually need a
fresh shell before their commands appear.

## 2. Install Baker

```bash
git clone https://github.com/chbrown13/Baker
cd Baker
npm install
npm link
```

`npm link` puts the `baker` command on your `PATH` so you can run it from any directory.

## 3. Install opunit

Baker uses opunit to check that an environment is set up correctly. Version **0.9.4 or newer** is
required; the command below installs the current one:

```bash
npm install -g ottomatica/opunit
```

## 4. Check it worked

Open a **new** terminal, then run:

```bash
baker --version
opunit --version
```

Both should print a version number. If they do, you are ready — continue to
[Getting started](getting-started.md).

---

## Extra setup — only if you are told you need it

Most configurations need nothing beyond the steps above. These come up only if the `baker.yml` you
were given asks for them.

**Docker** — only if your `baker.yml` starts with `docker:`. Install
[Docker Desktop](https://docs.docker.com/desktop/). On Linux, also run:

```bash
sudo usermod -aG docker $USER    # then log out and back in
```

**Ansible** — only if your `baker.yml` uses `lang:`, `services:`, or `custom:`, and only on Linux.
If a bake needs Ansible and you do not have it, Baker stops and says so **before changing
anything**.

```bash
sudo apt install ansible     # Debian / Ubuntu
sudo dnf install ansible     # Fedora / RHEL
brew install ansible         # macOS
```

## What Baker does to your machine

Baker writes where your configuration tells it to, plus its own folder at `~/.baker/` for caches
and logs.

**Nothing is sent anywhere.** Baker has no telemetry and reports nothing about you or your machine.
Everything it records stays on your computer.

To undo a setup, run `baker cleanup`. It shows you the full list before removing anything.

## If something goes wrong

| Problem | Fix |
|---|---|
| `baker: command not found` | Open a new terminal. If it persists, re-run `npm link` from the Baker folder. |
| `opunit not found on PATH` | Re-run step 3. |
| `EACCES` during `npm install -g` | Your global npm folder needs admin rights — see [Troubleshooting](troubleshooting.md). |
| `sudo: a password is required` | Your configuration uses the Ansible sections — see [Troubleshooting](troubleshooting.md#sudo-and-the-playbook-backed-tier). |
| Anything else | [Troubleshooting](troubleshooting.md) lists the common failures and their causes. |

## Next

- [Getting started](getting-started.md) — build your first environment
- [CLI reference](baker-commands.md) — every command and flag
