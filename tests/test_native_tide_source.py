import struct
import tempfile
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from classic_netcdf import netcdf_file
from tide_source_time import decode_times


def integer(n): return struct.pack('>I', n)
def name(s):
    b = s.encode(); return integer(len(b)) + b + b'\0' * (-len(b) % 4)


class NativeSourceTests(unittest.TestCase):
    def test_large_classic_record_file(self):
        # Sparse 4-GiB file exercises the original overflow without allocating it.
        nodes, count = 134217729, 4
        header = b'CDF\x01' + integer(count)
        header += integer(10) + integer(2) + name('time') + integer(0) + name('node') + integer(nodes)
        header += integer(0) * 2
        header += integer(11) + integer(1) + name('zeta') + integer(2) + integer(0) + integer(1)
        header += integer(0) * 2 + integer(6) + integer(nodes * 8)
        begin = len(header) + 4
        header += integer(begin)
        with tempfile.NamedTemporaryFile() as f:
            f.write(header)
            f.truncate(begin + count * nodes * 8)
            last = begin + (count - 1) * nodes * 8
            f.seek(last); f.write(struct.pack('>d', 1.25)); f.flush()
            with netcdf_file(f.name, mmap=True) as ds:
                self.assertEqual(ds.variables['zeta'].shape, (count, nodes))
                self.assertEqual(float(ds.variables['zeta'].data[-1, 0]), 1.25)

    def test_actual_adcirc_epoch_comment(self):
        result = decode_times([10998000, 11001600],
             b'seconds since 2026-05-26 12:00:00        ! NCDASE - BASE_DAT')
        self.assertEqual(result, ['2026-09-30T19:00:00Z', '2026-09-30T20:00:00Z'])

    def test_missing_or_reordered_hours_rejected(self):
        for times in ([0, 7200], [3600, 0], [0, float('nan')]):
            with self.assertRaises(ValueError):
                decode_times(times, 'seconds since 2026-10-01 00:00:00')

if __name__ == '__main__': unittest.main()
