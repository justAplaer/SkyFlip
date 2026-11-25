import pytest
import requests
from fastapi import HTTPException
from app.archive import routes

def test_fits_url_rejects_traversal_and_untrusted_hosts():
    for url in ['https://evil.example/ibe/data/spherex/a.fits', 'https://irsa.ipac.caltech.edu/ibe/data/spherex/%2e%2e/a.fits', 'https://irsa.ipac.caltech.edu:abc/ibe/data/spherex/a.fits', 'https://user@irsa.ipac.caltech.edu/ibe/data/spherex/a.fits']:
        with pytest.raises(HTTPException): routes.validate_spherex_fits_url(url)
    routes.validate_spherex_fits_url('https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/a.fits')

def test_fits_fetch_rejects_redirects(monkeypatch):
    class Response:
        status_code=302
    def get(url, timeout, allow_redirects):
        assert allow_redirects is False
        return Response()
    monkeypatch.setattr(routes.requests, 'get', get)
    with pytest.raises(requests.exceptions.RequestException):
        routes.fetch_validated_fits('https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/a.fits', 5)
