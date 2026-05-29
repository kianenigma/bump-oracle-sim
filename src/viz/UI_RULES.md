Guidelines for the UI:

There are a few key parameters here:

What is the current view-point (VP) of the user? The center of the screen
What is the current granularity of the view? 6h, 1h, 15m, 6s etc
What is the current zoom level of the user.

The rules:

* When the user pans right and left, all 3 charts move together.
* When the user zooms in and out, all 3 charts move together.
* When the user changes the granularity, all 3 charts change the granularity together AND THE VP REMAINS THE SAME AND THE ZOOM LEVEL REMAINS THE SAME.
* When the user changes the zoom level, all 3 charts change the zoom level together AND THE VP REMAINS THE SAME AND THE GRANULARITY REMAINS THE SAME.
* All data is loaded lazily -- we look at the viewport, and we load only the data that is needed to fulfill that viewport + that granularity.
	* We load a bit of data speculatively, to ensure that the user can pan and zoom without waiting for the data to load.
* If data is not available, the loading bar is shown, at the top right, until the data is loaded.
	* Once data is loaded, it is populated in the chart, and again, WITHOUT the viewport changing or granulairty.
* Enabling and disabling any of the price paths, or scenarios, should NOT change the viewport, ZOOM, or GRANULARITY, and should be done smoothly.
* Each VP has a maximum amount of allowed granularity. If we are super zoomed out, we should not be able to look at the chart at 6s granularity. To handle this:
	* When user zooms in, more granularity levels are shown.
	* When user zooms out, if a small granularity is selected, we should block further zooming out.
