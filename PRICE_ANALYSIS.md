# Price Analysis

This is a new `subcommand` of our script. What it does is:

* won't run any oracle simulations.
* It will instead only look at the entire historical data, and query **what would be as close as possible to a validator simply querying the spot price of one of the venues** (the least signal one, which probably is simply the last trade data?).
	* we need something here that is more fresh than a 15m candle.
	* Basically for this we need an API that is available to query live for the future, and is also available historically. Or we need to mimic it.
* We would do this, for each 6s, for each venue that we support.
* We then plot this entire history in a chart (using our existing trading view tools, but in a new html template).
  * We plot only price in each venue + one cross venue divergence chart (similar to what we have).
* Then, our CLI should report:
	* what percentage/duration of time divergence has been less than 0.5%?
	* what percentage/duration of time 0.5% < d < 1 (+ list of occurrences for manual inspection)
	* what percentage/duration of time 1 < d < 5% (+ list of occurrences for manual inspection)
	* I think the above will give us an answer about "what if we use just spot price"
	* This should be a clear evidence of your "even if we use mean in most of times we dont drift away from real price"
