import { join } from "node:path";

export class SprintArchiver {
  private readonly artifactsDir: string;

  constructor(artifactsDir: string) {
    this.artifactsDir = artifactsDir;
  }

  getArchivePath(sprintNumber: number): string {
    return join(this.artifactsDir, `sprint-${sprintNumber}-status.yaml`);
  }

  getActiveStatusPath(): string {
    return join(this.artifactsDir, "sprint-status.yaml");
  }

  async hasArchive(sprintNumber: number): Promise<boolean> {
    const archiveFile = Bun.file(this.getArchivePath(sprintNumber));
    return archiveFile.exists();
  }

  async archive(sprintNumber: number): Promise<void> {
    const archivePath = this.getArchivePath(sprintNumber);
    const activePath = this.getActiveStatusPath();

    if (await this.hasArchive(sprintNumber)) {
      throw new Error(`Archive already exists for sprint ${sprintNumber}: ${archivePath}`);
    }

    const activeFile = Bun.file(activePath);
    const activeExists = await activeFile.exists();
    if (!activeExists) {
      throw new Error(`Active sprint status file not found: ${activePath}`);
    }

    const content = await activeFile.text();
    await Bun.write(archivePath, content);
  }
}
