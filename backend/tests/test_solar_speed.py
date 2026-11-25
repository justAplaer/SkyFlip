import math
import pytest
from app.motion_speed import motion_speed_for_target
from app.models import MotionSpeedResponse

@pytest.mark.parametrize('target,radial', [('barnards_star',-110.5), ('rw_aurigae',14.0), ('r_draconis',-132.8)])
def test_solar_speed_combines_cited_radial_and_tangential(target,radial):
    data=motion_speed_for_target(target)
    assert data['radial_velocity_kms']==radial
    assert data['radial_velocity_citation']
    assert data['solar_speed_kms']==pytest.approx(math.hypot(data['tangential_velocity_kms'],radial))
    assert MotionSpeedResponse(**data).model_dump()['solar_speed_kms']==data['solar_speed_kms']

@pytest.mark.parametrize('target', ['wise0855','epsilon_indi_b'])
def test_unknown_radial_does_not_become_zero_or_total(target):
    data=motion_speed_for_target(target)
    assert data['radial_velocity_kms'] is None
    assert data['solar_speed_kms'] is None
    assert data['tangential_velocity_kms'] > 0
