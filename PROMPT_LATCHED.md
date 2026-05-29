# Latched Median

This is a new aggregator -- latched medina.

It is the same semantics as medina, but it has no min-inputs.

Instead, the aggregator internally will store the last updated price for each validator. For any inherent that comes in, it will update those that were updated, and then take the median over the new set of values.

This should be implemented as a new aggregator type.

Do not try and backwards implement this for every validator type that we have, other than honest, and `pushy-max` for now. The rest I will do myself upon inspection of your work.

