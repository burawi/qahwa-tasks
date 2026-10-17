import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { DomainError } from "../domain/errors.js";

export interface CommitProposalInput {
  message: string;
  repositoryRoot: string;
  baseRevision: string;
  files: string[];
  releaseNote: string;
}

export interface ReviewedSnapshot {
  status: string;
  files: Array<{ path: string; blob: string | null }>;
}

export interface StoredCommitProposal extends CommitProposalInput {
  snapshot: ReviewedSnapshot;
}

export class ReviewedCommitService {
  prepare(projectRoot: string, input: CommitProposalInput): StoredCommitProposal {
    const repositoryRoot = this.canonicalRoot(input.repositoryRoot);
    const expectedRoot = this.canonicalRoot(projectRoot);
    this.assert(repositoryRoot === expectedRoot, "Commit repository must match the task project root", "commit_root_mismatch");
    this.assert(this.git(repositoryRoot, ["rev-parse", "--show-toplevel"]) === repositoryRoot, "Project root must be the Git repository root", "commit_root_mismatch");
    const baseRevision = input.baseRevision.trim().toLowerCase();
    this.assert(/^[0-9a-f]{40}$/.test(baseRevision), "Commit base revision must be a full Git hash", "invalid_commit_proposal");
    this.assert(this.git(repositoryRoot, ["rev-parse", "HEAD"]) === baseRevision, "Repository revision has changed", "repository_drift", 409);
    const message = input.message.trim();
    const releaseNote = input.releaseNote.trim();
    this.assert(message.length > 0 && message.length <= 500, "Commit message must be 1–500 characters", "invalid_commit_proposal");
    this.assert(releaseNote.length > 0 && releaseNote.length <= 2_000, "Release note must be 1–2,000 characters", "invalid_commit_proposal");
    const files = this.paths(repositoryRoot, input.files);
    return { message, repositoryRoot, baseRevision, files, releaseNote, snapshot: this.snapshot(repositoryRoot, files) };
  }

  commit(proposal: StoredCommitProposal): string {
    this.assert(this.git(proposal.repositoryRoot, ["rev-parse", "HEAD"]) === proposal.baseRevision, "Repository revision has changed since review", "repository_drift", 409);
    this.assert(
      JSON.stringify(this.snapshot(proposal.repositoryRoot, proposal.files)) === JSON.stringify(proposal.snapshot),
      "Reviewed files have changed since review",
      "reviewed_files_drift",
      409,
    );
    const temporary = mkdtempSync(join(tmpdir(), "qahwa-reviewed-commit-"));
    const index = join(temporary, "index");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      this.git(proposal.repositoryRoot, ["read-tree", proposal.baseRevision], env);
      this.git(proposal.repositoryRoot, ["add", "-A", "--", ...proposal.files], env);
      const staged = this.nullList(this.gitBuffer(proposal.repositoryRoot, ["diff", "--cached", "--name-only", "-z"], env));
      this.assert(this.samePaths(staged, proposal.files), "Temporary commit scope does not match the reviewed files", "commit_scope_mismatch", 409);
      const tree = this.git(proposal.repositoryRoot, ["write-tree"], env);
      const commit = this.git(proposal.repositoryRoot, ["commit-tree", tree, "-p", proposal.baseRevision, "-m", proposal.message], env);
      this.git(proposal.repositoryRoot, ["update-ref", "HEAD", commit, proposal.baseRevision]);
      this.git(proposal.repositoryRoot, ["reset", "--quiet", "HEAD", "--", ...proposal.files]);
      const committed = this.nullList(this.gitBuffer(proposal.repositoryRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit]));
      this.assert(this.samePaths(committed, proposal.files), "Created commit did not match the reviewed scope", "commit_scope_mismatch", 500);
      return commit;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  private snapshot(root: string, files: string[]): ReviewedSnapshot {
    const changed = new Set([
      ...this.nullList(this.gitBuffer(root, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--", ...files])),
      ...this.nullList(this.gitBuffer(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...files])),
    ]);
    this.assert(this.samePaths([...changed], files), "Every reviewed file must have an uncommitted change", "commit_scope_mismatch");
    const status = this.gitBuffer(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...files]).toString("base64");
    const snapshots = files.map((path) => {
      const absolute = resolve(root, path);
      try {
        const stat = lstatSync(absolute);
        this.assert(stat.isFile(), "Reviewed paths must be regular files", "invalid_commit_proposal");
        return { path, blob: this.git(root, ["hash-object", `--path=${path}`, "--", path]) };
      } catch (error) {
        if (error instanceof DomainError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, blob: null };
        throw error;
      }
    });
    return { status, files: snapshots };
  }

  private paths(root: string, values: string[]): string[] {
    this.assert(values.length > 0 && values.length <= 200, "Commit scope must contain 1–200 files", "invalid_commit_proposal");
    const paths = values.map((value) => {
      const path = normalize(value.trim()).split(sep).join("/");
      this.assert(Boolean(path) && !isAbsolute(path) && path !== "." && !path.startsWith("../") && !/[\0-\x1f\x7f]/.test(path), "Commit paths must stay inside the repository", "invalid_commit_proposal");
      this.assert(!path.split("/").includes(".git"), "Commit paths cannot access Git metadata", "invalid_commit_proposal");
      const absolute = resolve(root, path);
      this.assert(relative(root, absolute) === path.split("/").join(sep), "Commit paths must be normalized repository-relative files", "invalid_commit_proposal");
      return path;
    });
    this.assert(new Set(paths).size === paths.length, "Commit scope contains duplicate files", "invalid_commit_proposal");
    return paths.sort();
  }

  private canonicalRoot(value: string): string {
    this.assert(isAbsolute(value.trim()), "Commit repository root must be absolute", "invalid_commit_proposal");
    try { return realpathSync(value.trim()); }
    catch { throw new DomainError("Commit repository root does not exist", "invalid_commit_proposal"); }
  }

  private samePaths(left: string[], right: string[]): boolean {
    return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
  }

  private nullList(value: Buffer): string[] {
    return value.toString("utf8").split("\0").filter(Boolean);
  }

  private git(root: string, args: string[], env = process.env): string {
    return this.gitBuffer(root, args, env).toString("utf8").trim();
  }

  private gitBuffer(root: string, args: string[], env = process.env): Buffer {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, env, encoding: "buffer", maxBuffer: 10 * 1024 * 1024 });
    if (result.error) throw new DomainError(`Git operation failed: ${result.error.message}`, "git_failed", 500);
    if (result.status !== 0) {
      const message = Buffer.concat([result.stderr ?? Buffer.alloc(0), result.stdout ?? Buffer.alloc(0)]).toString("utf8").trim();
      throw new DomainError(message || "Git operation failed", "git_failed", 409);
    }
    return result.stdout ?? Buffer.alloc(0);
  }

  private assert(condition: unknown, message: string, code: string, statusCode = 400): asserts condition {
    if (!condition) throw new DomainError(message, code, statusCode);
  }
}
