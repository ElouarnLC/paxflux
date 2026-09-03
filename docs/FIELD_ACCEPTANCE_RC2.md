# PaxFlux — RC2 physical field acceptance

> ## Physical acceptance status: **PENDING**
>
> Nothing in this document has been performed. It is a runbook to be carried
> out by the owner, on real phones, against a real HTTPS deployment. Every
> result cell is `NOT RUN` until someone fills it in.
>
> **No automated suite can produce this evidence.** CI runs headless Chromium
> on a Linux runner: it cannot install a PWA on an iPhone, cannot feel a
> vibration motor, and cannot lose signal in a marquee. That is the entire
> reason this file exists.

---

## How to use this document

1. Deploy the exact commit you intend to run the event on, over HTTPS
   (see [Production Deployment with Caddy](../README.md#3-production-deployment-with-caddy-automatic-https)).
2. Fill in **Run identification** below.
3. Work through the steps in order — several depend on the state the previous
   one leaves behind.
4. Mark every row. A blank cell is not a pass.
5. Change the status banner at the top of this file only when every
   **release gate** row is `PASS` or, where a gate genuinely does not apply,
   `NOT SUPPORTED` with a written justification.

### Result vocabulary

| Mark | Meaning |
| :--- | :--- |
| `PASS` | Observed to behave as described, on this device. |
| `FAIL` | Observed to behave otherwise. Record what happened. |
| `NOT SUPPORTED` | The device or browser does not implement the capability at all. Not a defect in PaxFlux. |
| `NOT RUN` | Not attempted. The default. |

### Gate or observation

Each step is labelled:

* **GATE** — a required RC2 release gate. A `FAIL` blocks the release.
* **OBS** — an observation about this particular device or browser. A
  `NOT SUPPORTED` here is information, not a failure: vibration, for
  instance, is a capability iOS browsers do not expose, and PaxFlux never
  promises counting depends on it.

The one place the distinction is easy to get wrong: **PWA installation is a
GATE** on a browser that supports installation over HTTPS, because installing
the counter is how a phone gets a service worker and therefore how it survives
losing the network. On a browser with no install API at all, record
`NOT SUPPORTED` and say which browser.

### Evidence hygiene

Screenshots and notes are welcome. **Never paste a pairing URL, a QR code
image, a `#` fragment, a session cookie or the contents of
`/data/setup-token.txt` into this file or into an issue.** A pairing token is
a credential; crop it out or describe it in words.

---

## Run identification

| Field | Value |
| :--- | :--- |
| Deployed Git SHA (`git rev-parse HEAD` on the deployed commit) | |
| Date and local time started | |
| Date and local time finished | |
| Public HTTPS origin used | |
| Reverse-proxy mode (bundled Caddy Compose / other — name it) | |
| `PUBLIC_BASE_URL` as configured | |
| Server host (machine, OS, Docker version) | |
| Operator running the acceptance | |

### Devices under test

Copy this block once per handset. Two devices are the minimum for step 11 and
step 16; three is closer to a real event.

| Field | Device A | Device B |
| :--- | :--- | :--- |
| Manufacturer and model | | |
| OS and version | | |
| Browser and version | | |
| Launched in ordinary browser or installed standalone | | |
| Did the browser offer installation? | | |
| Does the installed icon open `/` and land on `/counter`? | | |
| Does it still launch with the network unavailable? | | |

---

## Steps

### Deployment and preparation

| # | Step | What must be observed | Type | Result | Notes / evidence |
| :-- | :--- | :--- | :--- | :--- | :--- |
| 1 | Open the public HTTPS origin on a phone | Page loads with **no certificate warning and no interstitial**. The pairing screen shows no insecure-context warning. | GATE | NOT RUN | |
| 2 | Administrator opens `/admin` and creates or opens a draft event | Staff login works; the draft is reachable. | GATE | NOT RUN | |
| 3 | Edit the draft | Event metadata, timezone, topology (spaces) and allowed directions can all be changed **while the event is still a draft**, and the changes persist after reload. | GATE | NOT RUN | |
| 4 | Start the event | The event becomes live; the preflight check passes or explains what is missing. Topology is now locked. | GATE | NOT RUN | |
| 5 | Generate a pairing QR code | The QR resolves to the **public HTTPS origin**, not to a LAN IP or `localhost`. No warning about an unreachable or insecure base URL is shown. | GATE | NOT RUN | |

### The phone

| # | Step | What must be observed | Type | Result | Notes / evidence |
| :-- | :--- | :--- | :--- | :--- | :--- |
| 6 | Pair the physical phone by scanning the QR | The phone reaches the completion step. The token is single-use: scanning the same code again is refused. | GATE | NOT RUN | |
| 7 | Name the device | The optional name is accepted and appears on the counter and in supervision. Continuing without renaming also works. | GATE | NOT RUN | |
| 8 | Press **Tester la vibration** | Record what the screen reports: *demandée* (accepted), *refusée*, or *ce navigateur ne propose pas la vibration*. Whichever it is, the screen stays usable and counting is unaffected. | OBS | NOT RUN | Record the exact wording shown. `NOT SUPPORTED` is the expected result on iOS. |
| 9 | Install the application | The browser offers installation; install it; launch it from the home screen or app launcher; the smart root opens the **paired counter**, not a staff login. | GATE (see note above) | NOT RUN | |
| 10 | Read the identity on screen | The **phone's name** and the **checkpoint's name** are separately legible and not confusable. | GATE | NOT RUN | |

### Counting

| # | Step | What must be observed | Type | Result | Notes / evidence |
| :-- | :--- | :--- | :--- | :--- | :--- |
| 11 | Count online, both allowed directions, on two phones | Each tap gives immediate visual feedback. The gauge moves. Supervision reflects both doors. | GATE | NOT RUN | |
| 12 | Read the server/pending split | With counts queued, the counter states what the server holds and what this handset still owes it (`Serveur : n` · `+n en attente sur cet appareil`), and an operator can say which is which. | GATE | NOT RUN | |
| 13 | Reproduce a negative occupancy safely | From an occupancy of zero, count one outward movement (only if the topology allows it — otherwise `NOT SUPPORTED`). The value becomes `−1`, is **not** clamped to 0, and the anomaly notice is understandable. **Reset only by an audited correction or a fresh test event — never by editing database files.** | GATE | NOT RUN | |
| 14 | Offline counting | From a normally synced state, disable connectivity. Perform several counts: the projected value changes immediately and the pending state is understandable. Close and reopen the **installed** application while still offline — the counter shell and local state are still there. | GATE | NOT RUN | |
| 15 | Reconnect | Queued counts drain. No duplicate. The displayed gauge **does not jump** as the acknowledgement lands. The pending indicator clears. Supervision converges to the same figure. | GATE | NOT RUN | |

### Supervision, closing and recovery

| # | Step | What must be observed | Type | Result | Notes / evidence |
| :-- | :--- | :--- | :--- | :--- | :--- |
| 16 | Rename a phone from supervision | The open phone adopts the new name via heartbeat, with **no hard reload** and no re-pairing. | GATE | NOT RUN | |
| 17 | Watch device status change | A phone going online → offline → online is reflected in supervision, and analytics refresh, **without reloading the dashboard**. | GATE | NOT RUN | |
| 18 | Close the event | New counts are refused on the phones; counts queued *before* the closing transition still drain; the normal close gate behaves as documented. | GATE | NOT RUN | |
| 19 | Export | CSV and JSON exports are produced and are coherent with the figures on screen. | GATE | NOT RUN | |
| 20 | Restart the service | `docker compose restart` (or a host reboot): the event, the ledger and the occupancy survive intact. | GATE | NOT RUN | |
| 21 | Restore dry-run *(if operationally reasonable)* | Follow [Restoring from Backup](../README.md#restoring-from-backup). All sessions are invalidated: staff must log in again and **every phone must be paired again**. A re-paired phone adopts the **restored** occupancy, not its stale local state. | OBS | NOT RUN | Skipping is acceptable on a production instance; say so here. |

---

## Outcome

| | |
| :--- | :--- |
| Release gates: total / PASS / FAIL / NOT SUPPORTED / NOT RUN | |
| Observations: total / PASS / FAIL / NOT SUPPORTED / NOT RUN | |
| Blocking defects found (list, with the step number) | |
| Verdict | |

Any `FAIL` on a GATE row blocks RC2. Record it as an issue with the step
number, the device, and what was seen — and remember the evidence hygiene rule
above.

## What automated CI already covers, so you do not have to

Recorded here so the physical run stays focused on what only a physical run
can establish. These are covered by the suite on every commit, on headless
Chromium:

* pairing, single-use tokens, session revocation and re-pairing handoff;
* offline queueing, draining, idempotence and quarantine on identity change;
* the no-clamp invariant for negative and above-capacity occupancy, and
  convergence on acknowledgement without a double jump;
* the counter, the pairing screen and the admin surfaces across the
  320 / 360 / 375 / 390 / 412 / 768 / 1280 viewport matrix;
* the production manifest's launch contract (`id`, `start_url`, `scope`,
  `display`);
* Docker image build, fresh-boot smoke, and a Compose install → restart →
  restore cycle asserting that pre-snapshot sessions are rejected.

What it cannot cover, and what the steps above exist for: a real certificate
on a real domain, a real browser's install prompt, a real home-screen launch,
a real radio losing signal, and a real vibration motor.
