# Research Questions and Answers

## Meta

### Miscellaneous

* All research questions should be answered by running a simulation, and inspecting the outcome in the format of `SimulationSummary`. If any data is missing, we should add it there.
	* The simulation summary is likely saved in the `.simdata` file and can be read from there.
* In all simulations, we assume that if x% can be malicious, then the block author can also be one of the malicious ones with the same likelihood.
	* We can simulate otherwise where only the bumps are malicious but the author is always honest, but it is not realistic.

### Malicious Variants

For now, we have 2:

* malicious: produces bumps in the opposite direction of the honest validator
* pushy: produces bumps in the correct direction, but uses all available bumps in that direction to maximally push the price in that direction

Are there more notable ones that we should consider?

### Jitter

For now we assume 1% difference at most when different validators at the same time query the price. Is it a reasonable assumption?

We may simulate with `jitter=0`, but it is not realistic. More important is to know what is a sensible value for jitter, which is most likely simialr to 1% -- a small fraction.

## Main Research Question: Optimal Epsilon

We need to find an epsilon that behaves well in the following metrics:

* In the absence of bad validators, it can retain any price drop or increase in the history of DOT with a reasonably low deviation rate
* Increasing the epsilon up to a threshold generally improves deviation, but at a certain point, has two donwside effects:
	* Because of the jitter, the baseline deviation increases. We can clearly see this using our `deviationIntegral` or `averageDeviation` metrics.
	* In the presence of bad actors, they have more ability to steer the price in the wrong direction.

Ideally, we want to find an epsilon that:
* In the absence of bad actors:
	* In stable times, despite the jitter in price, produces minimal deviation
	* In volatile times, it can follow the price well enough
* In the presence of bad actors:
	* The system retains low deviation rate in both of the malicious variants that we so far have.
		* If more malicious variants are added, they should also be considered.

Our threshold for bad actors is 33% -- The system should behave very well up until this threshold, and be reasonable up to 49% bad actors. At 50% bac actors it can fully break down and that's fine.

### Goal and Inputs

Ultimately, this research framework will have some input criteria that will dictate the choice of the epsilon:

* Max tolerable deviation
* How much we prefer baseline low deviation vs. less peaks in deviation in case of sharp price changes
* And likely more inputs, depending on the user of this oracle -- a stable-coin for example.

The research framework shoudl
* encode these questions somewhere that they can be later easily changed
* run all relevant simulations that answer the above questions
	* Ideally for this we use 1 or few `scenario` (a feature in this codebase) such that the output date is saved and can be manually inspected
* generates a report that encapsulate:
	* Which scenarios were run
	* What is is `SimulationSummary` of each
	* Executive conclusion: What epsilon value best fulfills the input criteria?

### Timelines

We shall develop this research framework in the time period of `--start-date 2021-12-03 --end-date 2021-12-30`, as it is short enough and represents a good balance of slow and harsh changes. Once the framework is developed, we can run the simulations for the entire history of DOT.


## Aux Research Question: Voting System

TODO
