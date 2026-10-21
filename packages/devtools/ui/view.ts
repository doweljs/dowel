/** Panning and zooming the graph: one transform on the SVG's viewport group. */

/** Leaves room for the overlays at the top and bottom of the canvas. */
const FIT_PADDING = 44
const ZOOM = { min: 0.15, max: 3, fitMin: 0.2, fitMax: 1.25, wheel: 0.0015 }
/** A press that moves less than this is a click, not a drag. */
const CLICK_SLOP = 4

export class View {
	private x = 0
	private y = 0
	private k = 1
	/** Whether the current graph was fitted; a new graph, or a new selection, is fitted again. */
	fitted = false

	constructor(
		private readonly canvas: HTMLElement,
		private readonly host: HTMLElement,
	) {}

	/** Scales and centers the graph to the canvas. */
	fit(): void {
		const svg = this.host.querySelector('svg')
		if (svg === null) return
		const width = Number(svg.dataset['width'])
		const height = Number(svg.dataset['height'])
		const box = this.canvas.getBoundingClientRect()
		const k = Math.min(box.width / width, (box.height - FIT_PADDING * 2) / height)
		this.k = Math.min(ZOOM.fitMax, Math.max(ZOOM.fitMin, k))
		this.x = (box.width - width * this.k) / 2
		this.y = Math.max(FIT_PADDING, (box.height - height * this.k) / 2)
		this.fitted = true
		this.apply()
	}

	/** Applies the transform to the current SVG, after it was redrawn. */
	apply(): void {
		this.host
			.querySelector('#viewport')
			?.setAttribute('transform', `translate(${this.x},${this.y}) scale(${this.k})`)
	}

	/** Drag to pan, wheel to zoom about the pointer; a press without movement calls `click`. */
	listen(click: (target: Element | null) => void): void {
		const { canvas } = this
		let drag: { x: number; y: number; startX: number; startY: number; moved: boolean } | null = null
		canvas.addEventListener('pointerdown', (event) => {
			if (event.button !== 0 || (event.target as Element).closest('.hud') !== null) return
			drag = { x: event.clientX, y: event.clientY, startX: this.x, startY: this.y, moved: false }
			canvas.setPointerCapture(event.pointerId)
		})
		canvas.addEventListener('pointermove', (event) => {
			if (drag === null) return
			if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < CLICK_SLOP)
				return
			drag.moved = true
			canvas.classList.add('dragging')
			this.x = drag.startX + (event.clientX - drag.x)
			this.y = drag.startY + (event.clientY - drag.y)
			this.apply()
		})
		// Pointer capture retargets pointerup to the canvas, so clicks are detected here.
		canvas.addEventListener('pointerup', (event) => {
			const wasClick = drag !== null && !drag.moved
			drag = null
			canvas.classList.remove('dragging')
			if (wasClick) click(document.elementFromPoint(event.clientX, event.clientY))
		})
		canvas.addEventListener('pointercancel', () => {
			drag = null
			canvas.classList.remove('dragging')
		})
		canvas.addEventListener(
			'wheel',
			(event) => {
				event.preventDefault()
				const box = canvas.getBoundingClientRect()
				const px = event.clientX - box.left
				const py = event.clientY - box.top
				const k = Math.min(
					ZOOM.max,
					Math.max(ZOOM.min, this.k * Math.exp(-event.deltaY * ZOOM.wheel)),
				)
				this.x = px - (px - this.x) * (k / this.k)
				this.y = py - (py - this.y) * (k / this.k)
				this.k = k
				this.apply()
			},
			{ passive: false },
		)
		// The layout does not depend on the viewport, so a resize only refits it.
		window.addEventListener('resize', () => this.fit())
	}
}
