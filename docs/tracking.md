# Tracking a multi-repo program

A reusable structure for organizing work when an effort outgrows a single repository.

## When you need this

The single-repo workflow (have an idea, create a repo, write a PRD, run PRD-to-issues, execute) works when the effort is one project. It breaks when an effort grows into several projects that share one goal and span multiple repositories. At that point you are running a **program**, and you need two levels of structure above the issue.

## Three levels

- **Program.** The whole effort. One goal, many moving parts, multiple repositories.
- **Workstream.** A coherent slice of the program, usually one repository. It has its own PRD and its own issues.
- **Task.** One issue, in a workstream's repo. The unit of execution.

The single-repo workflow already handles the task level. The program and workstream levels are what is missing.

## The structure

### 1. One GitHub Project (v2) spanning every repo

A GitHub Project v2 can hold issues from many repositories at once. It is the single board for the whole program, the one place you see everything. Useful custom fields:

- **Workstream**, which slice of the program the item belongs to.
- **Status**: Inbox, Needs decision, Needs design, Ready, In progress, Done.
- **Phase**, optional, for sequencing.

### 2. A program hub repository

A dedicated repo that holds what belongs to no single workstream: the pitch, the architecture and design docs, the roadmap, and the epic-level issues. Component repos hold implementation; the hub holds the program.

### 3. Capture everything as an issue, including work that is not a task yet

Decisions, design passes, and unfinished threads are real, trackable items. "Decide X," "Design Y," "Finish Z" are legitimate issues. Distinguish them by **Status**, not by whether they are "real tasks." An undecided thing parked in the Needs decision column is tracked; it is simply not Ready yet. Nothing falls off the radar just because it is not yet a code task.

### 4. Epics in the hub, tasks in the component repos, linked

A hub issue like "Build component A" is an epic. GitHub sub-issues link it down to the implementation issues in component A's repo, and the Project board rolls the children up under the parent. The hub shows the shape of the program; the component repos show the work.

### 5. Run PRD-to-issues per workstream, as each ripens

Do not issue-ify the whole program at once. A workstream that is designed enough gets a PRD and a full set of task issues. A workstream still in design gets an epic plus a few design and decision issues. Write each workstream's PRD when it matures, then break it into issues in that workstream's repo. The board shows ripe workstreams as tasks and unripe ones as epics.

## How the pieces sequence

1. Name the program. Create the hub repo.
2. Stand up one Project board spanning the repos you have and the ones you will create.
3. Draft a program roadmap in the hub: the workstreams, their rough order, the epic list.
4. Create one epic issue in the hub per workstream.
5. As each workstream ripens, write its PRD, run PRD-to-issues into its repo, and link those issues under the workstream's epic.
6. Drive everything through the board's Status column as it moves from Inbox to Done.

## The principle

The program board is the single pane of glass. The hub repo is the program's home. Component repos are workstreams. Issues are tasks, and an issue is allowed to be a decision or a design pass, not only a code change.

## Skill mapping (niftymonkey toolchain)

- `kickoff` routes a new piece of work to the right sequence of skills.
- `write-prd` produces a workstream PRD.
- `prd-to-issues` breaks a PRD into independently-grabbable issues.
- `triage` moves issues through the Status states.
