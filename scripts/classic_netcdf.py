"""Classic NetCDF reader with wide integer arithmetic for large record files."""
from scipy.io import netcdf_file as _netcdf_file


class netcdf_file(_netcdf_file):
    """Avoid NumPy int32 overflow in SciPy's record-buffer length arithmetic.

    STOFS classic files exceed 4 GiB even though each record is smaller.
    Header integers must be Python integers before record count * stride.
    This does not change source values, offsets, dimensions, or timestamps.
    """

    def _unpack_int(self):
        return int(super()._unpack_int())

    def _unpack_int64(self):
        return int(super()._unpack_int64())
