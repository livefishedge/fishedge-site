"""Decode native tide valid times; never borrow a weather forecast's clock."""
import datetime as dt
import re
from concurrent.futures import ThreadPoolExecutor

import numpy as np


def decode_times(values, units):
    units = units.decode('ascii') if isinstance(units, bytes) else str(units)
    # ADCIRC appends a Fortran-style comment after the CF epoch.
    units = units.split('!', 1)[0].strip()
    match = re.fullmatch(r'(seconds|hours|days) since (.+)', units)
    if not match:
        raise ValueError(f'unsupported native time units: {units}')
    epoch = dt.datetime.fromisoformat(match[2].strip().replace('Z', '+00:00'))
    if epoch.tzinfo is None:
        epoch = epoch.replace(tzinfo=dt.timezone.utc)
    scale = {'seconds': 1, 'hours': 3600, 'days': 86400}[match[1]]
    seconds = np.asarray(values, dtype=float) * scale
    if len(seconds) < 2 or not np.isfinite(seconds).all():
        raise ValueError('native time axis is missing or non-finite')
    if not np.allclose(np.diff(seconds), 3600, rtol=0, atol=0.01):
        raise ValueError('native phase builder requires strictly hourly source times')
    return [(epoch + dt.timedelta(seconds=float(value))).astimezone(dt.timezone.utc)
            .isoformat(timespec='seconds').replace('+00:00', 'Z') for value in seconds]


def read_source_times(reader):
    var = reader.ds.variables['time']
    calendar = getattr(var, 'calendar', b'standard')
    if isinstance(calendar, bytes):
        calendar = calendar.decode('ascii')
    if calendar not in ('standard', 'gregorian', 'proleptic_gregorian'):
        raise ValueError(f'unsupported native calendar: {calendar}')
    count = int(var.data.shape[0])
    if count != int(reader.ds.variables['zeta'].data.shape[0]):
        raise ValueError('native time/zeta record count mismatch')
    dtype = var.data.dtype
    start, stride = reader.offset('time'), int(reader.ds._recsize)
    def read_one(index):
        raw = reader.range(start + index * stride, dtype.itemsize)
        return float(np.frombuffer(raw, dtype=dtype)[0])
    with ThreadPoolExecutor(max_workers=8) as pool:
        values = list(pool.map(read_one, range(count)))
    return decode_times(values, var.units)
