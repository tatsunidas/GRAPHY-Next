#!/usr/bin/env python3
# GRAPHY-Next Benchmark Phantom (GNBP-1)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
"""
Deterministic CT DICOM series writer for the GRAPHY-Next benchmark phantoms.

Every identifier is derived from a fixed root plus the series parameters, so
regenerating a phantom produces byte-identical files. That property is what
makes the benchmark independently reproducible: a third party runs the same
command and gets the same bytes, rather than "a similar dataset".
"""

from __future__ import annotations

import hashlib
import os
from typing import Sequence

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian

UID_ROOT = "1.2.826.0.1.3680043.10.1338."  # free-to-use root (Medical Connections)
IMPLEMENTATION_CLASS_UID = UID_ROOT + "0.1"
CT_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.2"

RESCALE_INTERCEPT = -1024  # stored value = HU - intercept, the ordinary CT convention
HU_MIN, HU_MAX = -1024, 3071


def deterministic_uid(*parts: object) -> str:
    """Stable UID derived from a fixed root and the given parts."""
    digest = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return UID_ROOT + str(int(digest[:32], 16))[:36]


def write_series(
    volume: np.ndarray,
    out_dir: str,
    *,
    series_description: str,
    patient_id: str,
    patient_name: str,
    pixel_spacing: Sequence[float],
    slice_thickness: float,
    series_number: int,
    uid_key: str,
    study_key: str,
    study_description: str,
    model_name: str,
    z_origin_mm: float = 0.0,
    body_part: str = "",
    protocol_name: str = "",
    frame_of_reference_key: str | None = None,
    modality: str = "CT",
    sop_class_uid: str = CT_IMAGE_STORAGE,
    spatial: bool = True,
    customize=None,
) -> None:
    """Write `volume` (n_slices, rows, cols) of HU values as a CT series.

    `z_origin_mm` is the patient-space z of the first slice. It exists so that a
    phantom whose content is defined about z = 0 can be written with patient
    coordinates that agree with its own ground truth. Leaving it at the default
    while building content about the centre silently offsets every z in the
    truth table by half the stack length, which would invalidate any
    position-dependent accuracy measurement.

    `spatial=False` omits ImageOrientationPatient / ImagePositionPatient /
    SliceLocation / FrameOfReferenceUID. Real CR and DX series look like this, and
    so does anything a viewer must refuse to register: without a patient-space
    frame there is nothing to align *to*. Producing such a series on purpose is
    the only way to test that the refusal path works and says why.

    `customize(ds, k)` runs just before the file is written, so a caller can add
    (or deliberately omit) modality-specific attributes.

    `frame_of_reference_key` overrides the key the FrameOfReferenceUID is derived
    from. It defaults to `study_key`, i.e. every series of a study shares one
    frame of reference, which is what GNBP-1 relies on. GNBP-2R needs to vary it
    independently: a registration engine branches on whether the two series claim
    the same frame of reference, and that branch has to be exercised by data that
    keeps the series in one study while declaring different frames.
    """
    if volume.ndim != 3:
        raise ValueError("volume must be 3-D (slices, rows, columns)")

    n_slices, rows, columns = volume.shape
    study_uid = deterministic_uid("study", study_key)
    series_uid = deterministic_uid("series", uid_key)
    frame_uid = deterministic_uid("for", frame_of_reference_key or study_key)

    os.makedirs(out_dir, exist_ok=True)

    for k in range(n_slices):
        sop_uid = deterministic_uid("sop", uid_key, k)

        fm = FileMetaDataset()
        fm.MediaStorageSOPClassUID = sop_class_uid
        fm.MediaStorageSOPInstanceUID = sop_uid
        fm.TransferSyntaxUID = ExplicitVRLittleEndian
        # Fixed, never generated: a per-run UID here would break reproducibility.
        fm.ImplementationClassUID = IMPLEMENTATION_CLASS_UID
        fm.ImplementationVersionName = "GNBP-1"

        ds = Dataset()
        ds.file_meta = fm

        # --- SOP Common ---------------------------------------------------
        ds.SpecificCharacterSet = "ISO_IR 100"
        ds.SOPClassUID = sop_class_uid
        ds.SOPInstanceUID = sop_uid
        ds.InstanceCreationDate = "20260730"
        ds.InstanceCreationTime = "120000"

        # --- Patient ------------------------------------------------------
        ds.PatientName = patient_name
        ds.PatientID = patient_id
        ds.PatientBirthDate = ""
        ds.PatientSex = ""
        # This is synthetic data, not de-identified patient data. Saying so in
        # the header keeps the series from ever being mistaken for a real case.
        ds.PatientIdentityRemoved = "YES"
        ds.DeidentificationMethod = "Synthetic phantom; contains no real patient data"

        # --- General Study ------------------------------------------------
        ds.StudyInstanceUID = study_uid
        ds.StudyDate = "20260730"
        ds.StudyTime = "120000"
        ds.ReferringPhysicianName = ""
        ds.StudyID = "1"
        ds.AccessionNumber = ""
        ds.StudyDescription = study_description

        # --- General Series -----------------------------------------------
        ds.Modality = modality
        ds.SeriesInstanceUID = series_uid
        ds.SeriesNumber = series_number
        ds.SeriesDate = "20260730"
        ds.SeriesTime = "120000"
        ds.SeriesDescription = series_description
        ds.Laterality = ""
        # Type 2C for CT and used by viewers to label L/R/A/P. Head-first supine
        # is consistent with the axial IOP written below.
        ds.PatientPosition = "HFS"
        ds.BodyPartExamined = body_part
        ds.ProtocolName = protocol_name

        # --- Frame of Reference -------------------------------------------
        if spatial:
            ds.FrameOfReferenceUID = frame_uid
            ds.PositionReferenceIndicator = ""

        # --- General Equipment --------------------------------------------
        ds.Manufacturer = "GRAPHY-Next benchmark phantom"
        ds.ManufacturerModelName = model_name
        ds.InstitutionName = "Visionary Imaging Services, Inc."
        ds.StationName = "GNBP"
        ds.DeviceSerialNumber = "GNBP-1"
        ds.SoftwareVersions = model_name

        # --- General Image ------------------------------------------------
        ds.InstanceNumber = k + 1
        ds.ImageType = ["DERIVED", "SECONDARY", "AXIAL"]
        ds.ContentDate = "20260730"
        ds.ContentTime = "120000"
        ds.AcquisitionNumber = 1
        ds.AcquisitionDate = "20260730"
        ds.AcquisitionTime = "120000"
        # Row/column direction letters matching the axial IOP below.
        ds.PatientOrientation = ["L", "P"]
        ds.BurnedInAnnotation = "NO"
        ds.LossyImageCompression = "00"
        ds.ImageComments = "Synthetic digital phantom generated for benchmarking; not a real acquisition"

        # --- Image Plane ---------------------------------------------------
        ds.SliceThickness = slice_thickness
        ds.SpacingBetweenSlices = slice_thickness
        ds.PixelSpacing = list(pixel_spacing)
        # Axial, no obliquity: rows run left-to-right (+x), columns run
        # anterior-to-posterior (+y).
        if spatial:
            ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
            # Centred on the origin in x/y. `z_origin_mm` places the first slice so
            # that patient coordinates agree with the phantom's own ground truth.
            ds.ImagePositionPatient = [
                -(columns - 1) / 2.0 * pixel_spacing[0],
                -(rows - 1) / 2.0 * pixel_spacing[1],
                z_origin_mm + k * slice_thickness,
            ]
            ds.SliceLocation = z_origin_mm + k * slice_thickness

        # --- Image Pixel ---------------------------------------------------
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.Rows = rows
        ds.Columns = columns
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0  # unsigned; HU recovered through the rescale pair

        # --- CT Image ------------------------------------------------------
        ds.RescaleIntercept = RESCALE_INTERCEPT
        ds.RescaleSlope = 1
        ds.RescaleType = "HU"
        ds.WindowCenter = 40
        ds.WindowWidth = 400
        ds.WindowCenterWidthExplanation = "SOFT TISSUE"
        # Nominal acquisition parameters. They describe no real exposure — the
        # data is computed, not scanned — but they are the attributes a CT
        # viewer expects to find, and their presence exercises the metadata
        # paths that a bare minimum header would leave untested. The synthetic
        # origin is declared in ImageType, ImageComments and
        # DeidentificationMethod so the values cannot be read as measurements.
        ds.KVP = 120
        ds.GantryDetectorTilt = 0.0
        ds.TableHeight = 0.0
        ds.RotationDirection = "CW"
        ds.ScanOptions = "HELICAL MODE"
        ds.ConvolutionKernel = "STANDARD"
        ds.FilterType = "NONE"
        ds.DataCollectionDiameter = columns * pixel_spacing[0]
        ds.ReconstructionDiameter = columns * pixel_spacing[0]
        ds.DistanceSourceToDetector = 1000.0
        ds.DistanceSourceToPatient = 550.0
        ds.ExposureTime = 500
        ds.XRayTubeCurrent = 200
        ds.Exposure = 100
        ds.GeneratorPower = 24
        ds.FocalSpots = 0.7

        stored = (volume[k].astype(np.int32) - RESCALE_INTERCEPT).astype(np.uint16)
        ds.PixelData = stored.tobytes()

        if customize is not None:
            customize(ds, k)

        ds.save_as(os.path.join(out_dir, f"{k + 1:04d}.dcm"), enforce_file_format=True)


def series_checksum(out_dir: str) -> str:
    """MD5 over the concatenated series, for the reproducibility statement."""
    h = hashlib.md5()
    for name in sorted(os.listdir(out_dir)):
        with open(os.path.join(out_dir, name), "rb") as fh:
            h.update(fh.read())
    return h.hexdigest()
