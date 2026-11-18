/** The part of Electron's tray the controller drives. */
export interface TrayLike {
	setToolTip(text: string): void
	setContextMenu(menu: unknown): void
	on(event: 'click', listener: () => void): unknown
	destroy(): void
}

export interface TrayHost {
	/** The icon to draw, or nothing when none could be found. Asked once. */
	loadIcon(): Promise<unknown | undefined>
	makeTray(icon: unknown): TrayLike
	menu(template: { label?: string; type?: 'separator'; click?: () => void }[]): unknown
	/** Brings a window forward, making one when none is open. */
	open(): void
	/** Quits the way the application menu does. */
	quit(): void
	record(error: unknown): void
}

/**
 * The tray icon and its menu (Open, Quit). While the icon is up the app keeps running when its last
 * window closes; when it could not be drawn, closing still quits, so the app never runs with nothing
 * on screen to bring it back.
 */
export class TrayController {
	private tray: TrayLike | undefined
	private failure: string | undefined
	private chain: Promise<void> = Promise.resolve()
	private icon: Promise<unknown | undefined> | undefined

	constructor(private readonly host: TrayHost) {}

	/** Whether the icon is up, so closing the last window leaves the app running. */
	shown(): boolean {
		return this.tray !== undefined
	}

	problem(): string | undefined {
		return this.failure
	}

	/** Brings the tray in line with the wish. Calls run one after the other. */
	sync(wanted: boolean, name: string): Promise<void> {
		this.chain = this.chain.then(() => this.apply(wanted, name))
		return this.chain
	}

	/** Resolves once every `sync` asked so far is done. */
	settled(): Promise<void> {
		return this.chain
	}

	dispose(): void {
		this.tray?.destroy()
		this.tray = undefined
	}

	private async apply(wanted: boolean, name: string): Promise<void> {
		if (!wanted) {
			this.dispose()
			this.failure = undefined
			return
		}
		if (this.tray) return
		try {
			this.icon ??= this.host.loadIcon()
			const icon = await this.icon
			if (icon === undefined) {
				this.icon = undefined
				this.failure = `Namzu could not find its icon for the ${name.toLowerCase()}, so closing the window still quits.`
				return
			}
			const tray = this.host.makeTray(icon)
			tray.setToolTip('Namzu')
			tray.setContextMenu(
				this.host.menu([
					{ label: 'Open Namzu', click: () => this.host.open() },
					{ type: 'separator' },
					{ label: 'Quit Namzu', click: () => this.host.quit() },
				]),
			)
			tray.on('click', () => this.host.open())
			this.tray = tray
			this.failure = undefined
		} catch (error) {
			this.host.record(error)
			this.failure = `Namzu could not add its icon to the ${name.toLowerCase()}, so closing the window still quits.`
		}
	}
}
