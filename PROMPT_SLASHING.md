Let's now add two features to our aggregators:

## min inputs
They should have a way to express `min_inputs`. For nudge, it is 0. For mean and median, the defauly
should be 2/3+1 of all validators, ensuring at least 50%+1 of the data points, are coming from
honest validators (Polkadot assumes 2/3 honest) so median is protected.

If criteria is not met, price is not updated and we move on.

## Confidence tracking

Each aggregator whould receive the final inherent, and in the inherent we know which input pertained
to which validators. Each aggregator should hold an internal `Map<Validator, [0 to 1]>` that is the
confidence in that validator.

Then they should have configurable functions that would let us express "update validators confidence
if they are too far from mean/median".

I think we can have one callback configurable in each aggregator, which receives the inputs in the
inhernet, and the final concluded price, and can update the confidence map.

The same function can be used to recover a validator's confidence once for example they submit a few
good prices.

Both mean and median ignore that validator once their confidence drops to 0. Mean can also apply
this confidence as a weight to the mean/average it computes.

For this function, my thoughts are as follows:

## Confidence tracking function

The code idea is that unlike nudge, in the mean/median, there is no reason for a validator to NOT
include signed statements from everyone in the inherent. The more, the better.

In each inherent, we go over all possible validators.
* If they are not in the inherent => Either lazy (actually not possible in our simulation, because
	we cannot mock network delay), or they are being censored by a malicious validators * confidence
	should be reduced by a constant factor, ideally giving validator enough blocks to come back to 100% confidence if they resume submitting good inputs.
* If they are in the inherent, then measure `d` distance to final price. Then we need a good
	function that behave as such: * if `d` is less than +- 1% of final price, confidence should be
	increased (clamped to 100%) * else confidence should be reduced,

The nudge aggregator can also have this, but it would simply be a noop, and the confidence of
everyone remains at 1.


# UI
We should have a way to show the confidence metric of our validators in the UI. We should add a new
tab, that contains this information. A simple chart would do, but I should be able to select
individual validators, see what type they are, and see their confidence over time.

## Research for parameters

> CLAUDE: Next phase, just read it for now but don't need to take action.

We need to perform research to conclude the optimal parameters for the following:

In general, we know median is better than mean, so we ignore mean.

* amount of trimming pre-median (0 is a valid option)
* `min-inputs`
* confidence parameters, how much to reduce if absent, what is the function if present.

Then we measure this against all variations and combinations of malicioius activity with bump model
head to head.

Then, we take the best one and we ask claude to destroy it by writing the most intelligent attacker
validator that it can.
